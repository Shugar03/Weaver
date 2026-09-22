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

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    NextId,
    Worker, // S23: pubkey ed25519 del forge que firma resultados (Proof L0)
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
    pub amount: i128,
    pub state: JobState,
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
}

#[contract]
pub struct WeaverEscrow;

#[contractimpl]
impl WeaverEscrow {
    pub fn version(_env: Env) -> u32 {
        3
    }

    /// S23: worker_pubkey = clave ed25519 del forge cuyas firmas valida release.
    pub fn init(
        env: Env,
        admin: Address,
        token: Address,
        worker_pubkey: BytesN<32>,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        // S22: sin esto, el primero en llamar init en un deploy fresco quedaba
        // admin sin firmar nada. El admin propuesto debe autorizarlo.
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Worker, &worker_pubkey);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        env.storage().instance().extend_ttl(DAY_LEDGERS, TTL_30D);
        Ok(())
    }

    /// Fondea un job: mueve amount del cliente al contrato. Devuelve job_id (u64).
    pub fn fund_job(env: Env, client: Address, amount: i128) -> Result<u64, Error> {
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let (_admin, token) = Self::require_init(&env)?;
        client.require_auth();
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
                amount,
                state: JobState::Funded,
                result_hash: None,
            },
        );
        Self::emit(&env, symbol_short!("funded"), id, client, amount, None);
        env.storage().instance().extend_ttl(DAY_LEDGERS, TTL_30D);
        Ok(id)
    }

    /// Solo admin: paga el escrow al worker, atado al hash del resultado (S22).
    /// S23 — Proof L0: release exige la firma ed25519 del forge sobre result_hash.
    /// Sin recibo firmado por el forge registrado, no hay pago: el contrato
    /// VERIFICA la entrega, no solo la declara.
    pub fn release(
        env: Env,
        caller: Address,
        job_id: u64,
        worker: Address,
        result_hash: BytesN<32>,
        forge_sig: BytesN<64>,
    ) -> Result<(), Error> {
        let (admin, token) = Self::require_init(&env)?;
        caller.require_auth();
        if caller != admin {
            return Err(Error::Unauthorized);
        }
        let pubkey: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Worker)
            .ok_or(Error::NotInitialized)?;
        // Firma inválida → trap del host (la tx entera revierte, incluido el job).
        env.crypto().ed25519_verify(
            &pubkey,
            &result_hash.clone().into(),
            &forge_sig,
        );
        let mut job = Self::load_job(&env, job_id)?;
        if job.state != JobState::Funded {
            return Err(Error::BadState);
        }
        job.state = JobState::Released;
        job.result_hash = Some(result_hash.clone());
        Self::save_job(&env, job_id, &job);
        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &worker,
            &job.amount,
        );
        Self::emit(
            &env,
            symbol_short!("released"),
            job_id,
            worker,
            job.amount,
            Some(result_hash),
        );
        env.storage().instance().extend_ttl(DAY_LEDGERS, TTL_30D);
        Ok(())
    }

    /// Cliente o admin: devuelve el escrow al cliente.
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
        testutils::Address as _,
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
        WeaverEscrowClient::new(&env, &contract_id).init(&admin, &token_id, &worker_pubkey);
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
        let pubkey = BytesN::from_array(&env, &[9u8; 32]);
        assert_eq!(
            contract.try_init(&admin, &token_id, &pubkey),
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
        let pubkey = BytesN::from_array(&env, &[9u8; 32]);
        let contract_id = env.register(WeaverEscrow, ());
        WeaverEscrowClient::new(&env, &contract_id).init(&admin, &token_id, &pubkey);
        let auths = env.auths();
        assert!(
            auths.iter().any(|(addr, _)| *addr == admin),
            "init debe exigir auth del admin"
        );
    }

    #[test]
    fn fund_mueve_tokens_y_deja_funded() {
        let (env, _, client, _, token_id, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        let before = t.balance(&client);
        let id = contract.fund_job(&client, &PAYOUT);
        assert_eq!(id, 1);
        assert_eq!(t.balance(&client), before - PAYOUT);
        let job = contract.get_job(&1);
        assert_eq!(job.state, JobState::Funded);
        assert_eq!(job.amount, PAYOUT);
        assert_eq!(job.client, client);
    }

    #[test]
    fn fund_cero_falla() {
        let (env, _, client, _, _, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        assert_eq!(
            contract.try_fund_job(&client, &0),
            Err(Ok(Error::BadAmount))
        );
    }

    #[test]
    fn release_paga_al_worker_y_ata_al_resultado() {
        // S22/S23: el pago exige el hash del resultado Y la firma del forge (L0).
        let (env, admin, client, worker, token_id, contract_id, sk) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        contract.fund_job(&client, &PAYOUT);
        let before = t.balance(&worker);
        let hash = BytesN::from_array(&env, &HASH);
        contract.release(&admin, &1, &worker, &hash, &sign(&env, &sk, &HASH));
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
        contract.fund_job(&client, &PAYOUT);
        let hash = BytesN::from_array(&env, &HASH);
        let bad_sig = sign(&env, &mallory_sk, &HASH);
        assert!(contract
            .try_release(&admin, &1, &worker, &hash, &bad_sig)
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
        contract.fund_job(&client, &PAYOUT);
        assert_eq!(
            contract.try_release(&mallory, &1, &worker, &hash, &sig),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn doble_release_falla() {
        let (env, admin, client, worker, _, contract_id, sk) = setup();
        let contract = contract_of(&env, &contract_id);
        let hash = BytesN::from_array(&env, &HASH);
        let sig = sign(&env, &sk, &HASH);
        contract.fund_job(&client, &PAYOUT);
        contract.release(&admin, &1, &worker, &hash, &sig);
        assert_eq!(
            contract.try_release(&admin, &1, &worker, &hash, &sig),
            Err(Ok(Error::BadState))
        );
    }

    #[test]
    fn refund_devuelve_al_cliente() {
        let (env, _, client, _, token_id, contract_id, _) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        contract.fund_job(&client, &PAYOUT);
        let before = t.balance(&client);
        contract.refund(&client, &1);
        assert_eq!(t.balance(&client), before + PAYOUT);
        assert_eq!(contract.get_job(&1).state, JobState::Refunded);
    }
}
