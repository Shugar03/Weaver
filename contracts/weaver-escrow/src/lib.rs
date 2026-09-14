#![no_std]
// weaver-escrow S5a — escrow mínimo para payouts Weaver en Stellar testnet.
// Patrón de escrows auditados: init con guard → fund (require_auth + transfer al
// contrato) → máquina Funded → release/refund con checks-effects-interactions.
// SIN expiry/cancel en MVP (declarado): solo jobs discretos.
// Rojo S5a: fns en todo!(), los tests deben fallar con panics.
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
};

const DAY_LEDGERS: u32 = 17_280; // ~24h a 5s por ledger
const TTL_30D: u32 = 30 * DAY_LEDGERS;

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    NextId,
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
        1
    }

    pub fn init(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
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
            },
        );
        Self::emit(&env, symbol_short!("funded"), id, client, amount);
        env.storage().instance().extend_ttl(DAY_LEDGERS, TTL_30D);
        Ok(id)
    }

    /// Solo admin: paga el escrow al worker.
    pub fn release(env: Env, caller: Address, job_id: u64, worker: Address) -> Result<(), Error> {
        let (admin, token) = Self::require_init(&env)?;
        caller.require_auth();
        if caller != admin {
            return Err(Error::Unauthorized);
        }
        let mut job = Self::load_job(&env, job_id)?;
        if job.state != JobState::Funded {
            return Err(Error::BadState);
        }
        job.state = JobState::Released;
        Self::save_job(&env, job_id, &job);
        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &worker,
            &job.amount,
        );
        Self::emit(&env, symbol_short!("released"), job_id, worker, job.amount);
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
        Self::emit(&env, symbol_short!("refunded"), job_id, client, job.amount);
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

    fn emit(env: &Env, name: Symbol, job_id: u64, party: Address, amount: i128) {
        env.events().publish((name, job_id), (party, amount));
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::Address as _,
        token::{Client as TokenClient, StellarAssetClient},
    };

    const UNIT: i128 = 10_000_000; // 1.0 USDC con 7 decimales
    const PAYOUT: i128 = 100_000; // $0.01 demo

    fn setup() -> (Env, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let client = Address::generate(&env);
        let worker = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = sac.address();
        StellarAssetClient::new(&env, &token_id).mint(&client, &(1_000 * UNIT));
        let contract_id = env.register(WeaverEscrow, ());
        WeaverEscrowClient::new(&env, &contract_id).init(&admin, &token_id);
        (env, admin, client, worker, token_id, contract_id)
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
        let (env, admin, _, _, token_id, contract_id) = setup();
        let contract = contract_of(&env, &contract_id);
        assert_eq!(
            contract.try_init(&admin, &token_id),
            Err(Ok(Error::AlreadyInitialized))
        );
    }

    #[test]
    fn fund_mueve_tokens_y_deja_funded() {
        let (env, _, client, _, token_id, contract_id) = setup();
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
        let (env, _, client, _, _, contract_id) = setup();
        let contract = contract_of(&env, &contract_id);
        assert_eq!(
            contract.try_fund_job(&client, &0),
            Err(Ok(Error::BadAmount))
        );
    }

    #[test]
    fn release_paga_al_worker() {
        let (env, admin, client, worker, token_id, contract_id) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        contract.fund_job(&client, &PAYOUT);
        let before = t.balance(&worker);
        contract.release(&admin, &1, &worker);
        assert_eq!(t.balance(&worker), before + PAYOUT);
        assert_eq!(contract.get_job(&1).state, JobState::Released);
    }

    #[test]
    fn release_de_extraño_falla() {
        let (env, _, client, worker, _, contract_id) = setup();
        let contract = contract_of(&env, &contract_id);
        let mallory = Address::generate(&env);
        contract.fund_job(&client, &PAYOUT);
        assert_eq!(
            contract.try_release(&mallory, &1, &worker),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn doble_release_falla() {
        let (env, admin, client, worker, _, contract_id) = setup();
        let contract = contract_of(&env, &contract_id);
        contract.fund_job(&client, &PAYOUT);
        contract.release(&admin, &1, &worker);
        assert_eq!(
            contract.try_release(&admin, &1, &worker),
            Err(Ok(Error::BadState))
        );
    }

    #[test]
    fn refund_devuelve_al_cliente() {
        let (env, _, client, _, token_id, contract_id) = setup();
        let contract = contract_of(&env, &contract_id);
        let t = token_of(&env, &token_id);
        contract.fund_job(&client, &PAYOUT);
        let before = t.balance(&client);
        contract.refund(&client, &1);
        assert_eq!(t.balance(&client), before + PAYOUT);
        assert_eq!(contract.get_job(&1).state, JobState::Refunded);
    }
}
