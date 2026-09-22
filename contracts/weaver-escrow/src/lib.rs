#![no_std]
// weaver-escrow S5a — escrow mínimo para payouts Weaver en Stellar testnet.
// Patrón de escrows auditados: init con guard → fund (require_auth + transfer al
// contrato) → máquina Funded → release/refund con checks-effects-interactions.
// SIN expiry/cancel en MVP (declarado): solo jobs discretos.
// Rojo S5a: fns en todo!(), los tests deben fallar con panics.
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
    Symbol,
};

const DAY_LEDGERS: u32 = 17_280; // ~24h a 5s por ledger
const TTL_30D: u32 = 30 * DAY_LEDGERS;
// S43 (I6): ventana de claim — el escrow fondeado es incobrable por refund
// durante 24h: el forge tiene un día garantizado para self-claimear antes
// de que el operador pueda recuperar la plata (anti refund-rug).
const CLAIM_WINDOW_SECS: u64 = 86_400;

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    NextId,
    // S41: worker (address de payout) → pubkey ed25519 que firma sus proofs.
    // Per-forge: un map, no una clave global — la red tiene N forges.
    Forge(Address),
    Job(u64),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum JobState {
    Funded,
    Released,
    Refunded,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub client: Address,
    // S42: el job se liga al worker AL FONDEAR — eso habilita self-claim:
    // el forge puede cobrar sin depender de que el operador llame release.
    pub worker: Address,
    pub amount: i128,
    pub state: JobState,
    // S43: timestamp del ledger al fondear — habilita la ventana de claim
    // (refund bloqueado hasta funded_at + CLAIM_WINDOW_SECS).
    pub funded_at: u64,
    // S22: sha256 del output servido. El release lo exige y lo deja on-chain:
    // el pago queda atado a UN resultado concreto, auditable por cualquiera.
    pub result_hash: Option<BytesN<32>>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    JobNotFound = 4,
    BadState = 5,
    BadAmount = 6,
    ForgeNotFound = 7,
    TooEarly = 8, // refund dentro de la ventana de claim del worker (S43)
}

#[contract]
pub struct WeaverEscrow;

#[contractimpl]
impl WeaverEscrow {
    pub fn version(_env: Env) -> u32 {
        4
    }

    /// S41: init ya no recibe worker_pubkey — las claves de firma son per-forge
    /// (register_forge). Admin solo fija quién opera el escrow y qué token paga.
    pub fn init(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        // S22: sin esto, el primero en llamar init en un deploy fresco quedaba
        // admin sin firmar nada. El admin propuesto debe autorizarlo.
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        env.storage().instance().extend_ttl(DAY_LEDGERS, TTL_30D);
        Ok(())
    }

    /// S41: un forge se registra a sí mismo — `worker.require_auth()` prueba
    /// control de la address de payout. La pubkey puede ser OTRA clave (hot key
    /// del daemon, cold wallet para cobrar): quien cobra autoriza quien firma.
    /// Re-registrar rota la clave — la decisión es del worker, no del admin.
    pub fn register_forge(
        env: Env,
        worker: Address,
        pubkey: BytesN<32>,
    ) -> Result<(), Error> {
        Self::require_init(&env)?;
        worker.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::Forge(worker.clone()), &pubkey);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Forge(worker.clone()), DAY_LEDGERS, TTL_30D);
        env.events()
            .publish((symbol_short!("forge"), worker), pubkey);
        Ok(())
    }

    /// Fondea un job: mueve amount del cliente al contrato. Devuelve job_id (u64).
    /// S42: el worker va ligado desde el fund — un forge no registrado no es
    /// fondeable (ForgeNotFound temprano, no escrow incobrable).
    pub fn fund_job(
        env: Env,
        client: Address,
        amount: i128,
        worker: Address,
    ) -> Result<u64, Error> {
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let (_admin, token) = Self::require_init(&env)?;
        client.require_auth();
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Forge(worker.clone()))
        {
            return Err(Error::ForgeNotFound);
        }
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        // Orden: transfer antes de guardar es seguro acá porque Soroban revierte
        // todo el tx ante cualquier error (atomicidad por defecto).
        token::Client::new(&env, &token).transfer(
            &client,
            &env.current_contract_address(),
            &amount,
        );
        Self::save_job(
            &env,
            id,
            &Job {
                client: client.clone(),
                worker: worker.clone(),
                amount,
                state: JobState::Funded,
                funded_at: env.ledger().timestamp(),
                result_hash: None,
            },
        );
        Self::emit(&env, symbol_short!("funded"), id, worker, amount, None);
        env.storage().instance().extend_ttl(DAY_LEDGERS, TTL_30D);
        Ok(id)
    }

    /// Paga el escrow al worker del job, atado al hash del resultado (S22).
    /// S23 — Proof L0: release exige la firma ed25519 del forge sobre result_hash.
    /// S42 — caller ∈ {admin, job.worker}: el operador liquida en el flujo
    /// normal post-serve; el forge puede self-claim si el operador no lo hace.
    /// Sin recibo firmado por el forge registrado, no hay pago: el contrato
    /// VERIFICA la entrega, no solo la declara.
    pub fn release(
        env: Env,
        caller: Address,
        job_id: u64,
        result_hash: BytesN<32>,
        forge_sig: BytesN<64>,
    ) -> Result<(), Error> {
        let (admin, token) = Self::require_init(&env)?;
        caller.require_auth();
        let mut job = Self::load_job(&env, job_id)?;
        if caller != admin && caller != job.worker {
            return Err(Error::Unauthorized);
        }
        if job.state != JobState::Funded {
            return Err(Error::BadState);
        }
        // S41: la firma se verifica contra la pubkey QUE ESE WORKER registró —
        // un proof del forge A no paga un job del forge B.
        let pubkey: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::Forge(job.worker.clone()))
            .ok_or(Error::ForgeNotFound)?;
        // Firma inválida → trap del host (la tx entera revierte, incluido el job).
        env.crypto().ed25519_verify(
            &pubkey,
            &result_hash.clone().into(),
            &forge_sig,
        );
        job.state = JobState::Released;
        job.result_hash = Some(result_hash.clone());
        Self::save_job(&env, job_id, &job);
        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &job.worker,
            &job.amount,
        );
        Self::emit(
            &env,
            symbol_short!("released"),
            job_id,
            job.worker.clone(),
            job.amount,
            Some(result_hash),
        );
        env.storage().instance().extend_ttl(DAY_LEDGERS, TTL_30D);
        Ok(())
    }

    /// Cliente o admin: devuelve el escrow al cliente — SOLO tras la ventana
    /// de claim (S43): si el worker no claimeó en 24h, la plata vuelve. Antes
    /// de eso el refund es un rug del trabajo ya servido → TooEarly.
    pub fn refund(env: Env, caller: Address, job_id: u64) -> Result<(), Error> {
        let (admin, token) = Self::require_init(&env)?;
        caller.require_auth();
        let mut job = Self::load_job(&env, job_id)?;
        if caller != job.client && caller != admin {
            return Err(Error::Unauthorized);
        }
        if job.state != JobState::Funded {
            return Err(Error::BadState);
        }
        if env.ledger().timestamp() < job.funded_at + CLAIM_WINDOW_SECS {
            return Err(Error::TooEarly);
        }
        job.state = JobState::Refunded;
        Self::save_job(&env, job_id, &job);
        let client = job.client.clone();
        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &client,
            &job.amount,
        );
        Self::emit(&env, symbol_short!("refunded"), job_id, client, job.amount, None);
        env.storage().instance().extend_ttl(DAY_LEDGERS, TTL_30D);
        Ok(())
    }

    pub fn get_job(env: Env, job_id: u64) -> Result<Job, Error> {
        env.storage().instance().extend_ttl(DAY_LEDGERS, TTL_30D);
        Self::load_job(&env, job_id)
    }

    fn require_init(env: &Env) -> Result<(Address, Address), Error> {
        let admin: Option<Address> = env.storage().instance().get(&DataKey::Admin);
        let token: Option<Address> = env.storage().instance().get(&DataKey::Token);
        match (admin, token) {
            (Some(a), Some(t)) => Ok((a, t)),
            _ => Err(Error::NotInitialized),
        }
    }

    fn load_job(env: &Env, job_id: u64) -> Result<Job, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Job(job_id))
            .ok_or(Error::JobNotFound)
    }

    fn save_job(env: &Env, job_id: u64, job: &Job) {
        env.storage().persistent().set(&DataKey::Job(job_id), job);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Job(job_id), DAY_LEDGERS, TTL_30D);
    }

    fn emit(
        env: &Env,
        name: Symbol,
        job_id: u64,
        party: Address,
        amount: i128,
        result_hash: Option<BytesN<32>>,
    ) {
        env.events().publish((name, job_id), (party, amount, result_hash));
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger as _},
        token::{Client as TokenClient, StellarAssetClient},
    };

    const UNIT: i128 = 10_000_000; // 1.0 USDC con 7 decimales
    const PAYOUT: i128 = 100_000; // $0.01 demo
    const HASH: [u8; 32] = [7u8; 32];

    fn sign(env: &Env, sk: &SigningKey, hash: &[u8; 32]) -> BytesN<64> {
        BytesN::from_array(env, &sk.sign(hash).to_bytes())
    }

    fn setup() -> (Env, Address, Address, Address, Address, Address, SigningKey) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let client = Address::generate(&env);
        let worker = Address::generate(&env);
        let worker_sk = SigningKey::from_bytes(&[42u8; 32]);
        let worker_pubkey = BytesN::from_array(&env, &worker_sk.verifying_key().to_bytes());
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = sac.address();
        StellarAssetClient::new(&env, &token_id).mint(&client, &(1_000 * UNIT));
        let contract_id = env.register(WeaverEscrow, ());
        let contract = WeaverEscrowClient::new(&env, &contract_id);
        contract.init(&admin, &token_id);
        // S41: el forge se auto-registra — su address de payout autoriza su
        // clave de firma (pueden ser distintas: hot key firma, cold cobra).
        contract.register_forge(&worker, &worker_pubkey);
        (env, admin, client, worker, token_id, contract_id, worker_sk)
    }

    fn contract_of<'a>(env: &'a Env, contract_id: &'a Address) -> WeaverEscrowClient<'a> {
        WeaverEscrowClient::new(env, contract_id)
    }

    fn token_of<'a>(env: &'a Env, token_id: &'a Address) -> TokenClient<'a> {
        TokenClient::new(env, token_id)
    }

    #[test]
    fn funded_evt_name_compiles() {
        // El símbolo del evento existe y el helper emit compila (se usa en green).
        let _ = symbol_short!("funded");
    }

    #[test]
    fn init_doble_falla() {
        let (env, admin, _, _, token_id, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        assert_eq!(
            contract.try_init(&admin, &token_id),
            Err(Ok(Error::AlreadyInitialized))
        );
    }

    #[test]
    fn init_requiere_auth_del_admin() {
        // S22: sin require_auth, el primero en llamar init queda admin.
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token_id = Address::generate(&env);
        let contract_id = env.register(WeaverEscrow, ());
        WeaverEscrowClient::new(&env, &contract_id).init(&admin, &token_id);
        let auths = env.auths();
        assert!(
            auths.iter().any(|(addr, _)| *addr == admin),
            "init debe exigir auth del admin"
        );
    }

    #[test]
    fn fund_a_forge_no_registrado_falla_temprano() {
        // S42: no se fondea lo incobrable — worker sin register_forge →
        // ForgeNotFound en fund, no en release.
        let (env, _, client, _, _, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        let stranger = Address::generate(&env);
        assert_eq!(
            contract.try_fund_job(&client, &PAYOUT, &stranger),
            Err(Ok(Error::ForgeNotFound))
        );
    }

    #[test]
    fn firma_de_otro_forge_no_paga() {
        // S41: forge B registrado firma — pero el job está ligado a A:
        // la clave que verifica es la de A, no "cualquier forge registrado".
        let (env, admin, client, worker_a, _, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        let worker_b = Address::generate(&env);
        let b_sk = SigningKey::from_bytes(&[77u8; 32]);
        contract.register_forge(&worker_b, &BytesN::from_array(&env, &b_sk.verifying_key().to_bytes()));
        contract.fund_job(&client, &PAYOUT, &worker_a);
        let hash = BytesN::from_array(&env, &HASH);
        assert!(contract
            .try_release(&admin, &1, &hash, &sign(&env, &b_sk, &HASH))
            .is_err());
        assert_eq!(contract.get_job(&1).state, JobState::Funded);
    }

    #[test]
    fn dos_forges_cobran_cada_uno_lo_suyo() {
        // S41/S42: la red real — N forges registrados, cada job ligado a su
        // worker, cada release verifica la clave del que cobra.
        let (env, admin, client, worker_a, token_id, contract_id, sk_a) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        let worker_b = Address::generate(&env);
        let b_sk = SigningKey::from_bytes(&[77u8; 32]);
        contract.register_forge(&worker_b, &BytesN::from_array(&env, &b_sk.verifying_key().to_bytes()));
        contract.fund_job(&client, &PAYOUT, &worker_a);
        contract.fund_job(&client, &PAYOUT, &worker_b);
        let hash = BytesN::from_array(&env, &HASH);
        contract.release(&admin, &1, &hash, &sign(&env, &sk_a, &HASH));
        contract.release(&admin, &2, &hash, &sign(&env, &b_sk, &HASH));
        assert_eq!(t.balance(&worker_a), PAYOUT);
        assert_eq!(t.balance(&worker_b), PAYOUT);
    }

    #[test]
    fn worker_self_claim_sin_admin() {
        // S42 (I4): el forge reclama su propio job — no depende del operador.
        let (env, _, client, worker, token_id, contract_id, sk) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        contract.fund_job(&client, &PAYOUT, &worker);
        let hash = BytesN::from_array(&env, &HASH);
        contract.release(&worker, &1, &hash, &sign(&env, &sk, &HASH));
        assert_eq!(t.balance(&worker), PAYOUT);
        assert_eq!(contract.get_job(&1).state, JobState::Released);
    }

    #[test]
    fn worker_no_puede_claimear_job_ajeno() {
        // S42: caller=worker solo vale para SU job — el de otro forge no.
        let (env, _, client, worker_a, _, contract_id, sk_a) = setup();
        let contract = contract_of(&env, &contract_id);
        let worker_b = Address::generate(&env);
        let b_sk = SigningKey::from_bytes(&[77u8; 32]);
        contract.register_forge(&worker_b, &BytesN::from_array(&env, &b_sk.verifying_key().to_bytes()));
        contract.fund_job(&client, &PAYOUT, &worker_a);
        let hash = BytesN::from_array(&env, &HASH);
        // B intenta claimear el job de A con la firma correcta de A:
        assert_eq!(
            contract.try_release(&worker_b, &1, &hash, &sign(&env, &sk_a, &HASH)),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn register_forge_rota_la_clave() {
        // S41: re-registrar cambia la pubkey — la vieja deja de verificar.
        let (env, admin, client, worker, _, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        let new_sk = SigningKey::from_bytes(&[99u8; 32]);
        contract.register_forge(&worker, &BytesN::from_array(&env, &new_sk.verifying_key().to_bytes()));
        contract.fund_job(&client, &PAYOUT, &worker);
        let hash = BytesN::from_array(&env, &HASH);
        contract.release(&admin, &1, &hash, &sign(&env, &new_sk, &HASH));
        assert_eq!(contract.get_job(&1).state, JobState::Released);
    }

    #[test]
    fn fund_mueve_tokens_y_deja_funded() {
        let (env, _, client, worker, token_id, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        let before = t.balance(&client);
        let id = contract.fund_job(&client, &PAYOUT, &worker);
        assert_eq!(id, 1);
        assert_eq!(t.balance(&client), before - PAYOUT);
        let job = contract.get_job(&1);
        assert_eq!(job.state, JobState::Funded);
        assert_eq!(job.amount, PAYOUT);
        assert_eq!(job.client, client);
        assert_eq!(job.worker, worker);
    }

    #[test]
    fn fund_cero_falla() {
        let (env, _, client, worker, _, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        assert_eq!(
            contract.try_fund_job(&client, &0, &worker),
            Err(Ok(Error::BadAmount))
        );
    }

    #[test]
    fn release_paga_al_worker_y_ata_al_resultado() {
        // S22/S23: el pago exige el hash del resultado Y la firma del forge (L0).
        let (env, admin, client, worker, token_id, contract_id, sk) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        contract.fund_job(&client, &PAYOUT, &worker);
        let before = t.balance(&worker);
        let hash = BytesN::from_array(&env, &HASH);
        contract.release(&admin, &1, &hash, &sign(&env, &sk, &HASH));
        assert_eq!(t.balance(&worker), before + PAYOUT);
        let job = contract.get_job(&1);
        assert_eq!(job.state, JobState::Released);
        assert_eq!(job.result_hash, Some(hash));
    }

    #[test]
    fn release_sin_firma_valida_falla() {
        // S23 Proof L0: una firma de otra clave (o sobre otro hash) → error.
        let (env, admin, client, worker, _, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        let mallory_sk = SigningKey::from_bytes(&[66u8; 32]);
        contract.fund_job(&client, &PAYOUT, &worker);
        let hash = BytesN::from_array(&env, &HASH);
        let bad_sig = sign(&env, &mallory_sk, &HASH);
        assert!(contract
            .try_release(&admin, &1, &hash, &bad_sig)
            .is_err());
        // El job sigue Funded: nada se pagó, nada se marcó.
        assert_eq!(contract.get_job(&1).state, JobState::Funded);
    }

    #[test]
    fn release_de_extraño_falla() {
        let (env, _, client, worker, _, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        let mallory = Address::generate(&env);
        let hash = BytesN::from_array(&env, &[0u8; 32]);
        let sig = BytesN::from_array(&env, &[0u8; 64]);
        contract.fund_job(&client, &PAYOUT, &worker);
        assert_eq!(
            contract.try_release(&mallory, &1, &hash, &sig),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn doble_release_falla() {
        let (env, admin, client, worker, _, contract_id, sk) = setup();
        let contract = contract_of(&env, &contract_id);
        let hash = BytesN::from_array(&env, &HASH);
        let sig = sign(&env, &sk, &HASH);
        contract.fund_job(&client, &PAYOUT, &worker);
        contract.release(&admin, &1, &hash, &sig);
        assert_eq!(
            contract.try_release(&admin, &1, &hash, &sig),
            Err(Ok(Error::BadState))
        );
    }

    #[test]
    fn refund_dentro_de_la_ventana_falla() {
        // S43 (I6): anti refund-rug — el operador no puede retirar el escrow
        // antes de que el worker haya tenido su ventana de claim.
        let (env, admin, client, worker, _, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        contract.fund_job(&client, &PAYOUT, &worker);
        assert_eq!(
            contract.try_refund(&client, &1),
            Err(Ok(Error::TooEarly))
        );
        assert_eq!(
            contract.try_refund(&admin, &1),
            Err(Ok(Error::TooEarly))
        );
        assert_eq!(contract.get_job(&1).state, JobState::Funded);
    }

    #[test]
    fn refund_tras_la_ventana_devuelve_al_cliente() {
        // S43: pasada la ventana el operador recupera la plata de un job
        // que el worker nunca claimeó (forge muerto, proof perdido).
        let (env, _, client, worker, token_id, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        contract.fund_job(&client, &PAYOUT, &worker);
        let now = env.ledger().timestamp();
        env.ledger().with_mut(|l| l.timestamp = now + CLAIM_WINDOW_SECS + 1);
        let before = t.balance(&client);
        contract.refund(&client, &1);
        assert_eq!(t.balance(&client), before + PAYOUT);
        assert_eq!(contract.get_job(&1).state, JobState::Refunded);
    }

    #[test]
    fn worker_claimea_incluso_tras_la_ventana() {
        // S43: la ventana bloquea el REFUND, no el release — un forge que
        // vuelve después de días cobra igual si el operador no refundió.
        let (env, _, client, worker, token_id, contract_id, sk) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        contract.fund_job(&client, &PAYOUT, &worker);
        env.ledger().with_mut(|l| l.timestamp += CLAIM_WINDOW_SECS * 3);
        let hash = BytesN::from_array(&env, &HASH);
        contract.release(&worker, &1, &hash, &sign(&env, &sk, &HASH));
        assert_eq!(t.balance(&worker), PAYOUT);
    }
}
