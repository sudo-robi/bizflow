#![no_std]
// The public contract API uses `env.events().publish(...)` as specified; the
// SDK v30 marks the low-level helper deprecated in favour of #[contractevent],
// but the emitted on-chain event format is identical.
#![allow(deprecated)]

//! BizFlow milestone escrow.
//!
//! One deployed contract instance represents exactly one agreement. The
//! `agreement_id` passed to `init` is the unique, off-chain identifier stored
//! in the agreement record and included in every emitted event.
//!
//! The agreed asset must be the address of a Stellar Asset Contract (SAC).
//! Native XLM is not hardcoded here: wrap it in its SAC and pass that address.
//! No issuer or contract address is invented or embedded in this code.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short,
    token::TokenClient, Address, Env, String, Vec,
};

/// ~10 minutes per ledger on Stellar.
const LEDGERS_PER_DAY: u32 = 24 * 6;

const INSTANCE_TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 10;
const INSTANCE_TTL_EXTEND: u32 = LEDGERS_PER_DAY * 20;
const PERSISTENT_TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
const PERSISTENT_TTL_EXTEND: u32 = LEDGERS_PER_DAY * 60;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    InvalidMilestone = 5,
    InvalidState = 6,
    InsufficientBalance = 7,
    AlreadyReleased = 8,
    NotApproved = 9,
    ExceedsTotal = 10,
    InvalidAsset = 11,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    /// Initial state: no funds received yet.
    Created,
    /// At least one funding transfer completed.
    Funded,
    /// Every milestone has been released.
    Completed,
    /// All funds returned to the payer; no milestone was released.
    Refunded,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Agreement {
    pub agreement_id: u64,
    pub payer: Address,
    pub payee: Address,
    /// `None` is intentionally unsupported on-chain: native XLM must be
    /// wrapped in its Stellar Asset Contract and its address supplied here.
    pub asset: Option<Address>,
    pub total_amount: i128,
    pub milestone_count: u32,
    pub funded: i128,
    pub released: i128,
    pub remaining: i128,
    pub authorized: Address,
    pub status: Status,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub index: u32,
    pub description: String,
    pub amount: i128,
    pub approved: bool,
    pub released: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BalanceInfo {
    pub funded: i128,
    pub released: i128,
    pub remaining: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// The single agreement held by this contract instance.
    Agreement,
    Milestone(u32),
}

#[contract]
pub struct BizflowEscrow;

#[contractimpl]
impl BizflowEscrow {
    /// Initializes the agreement. May only be called once per instance.
    ///
    /// `milestones` amounts must sum exactly to `total_amount` so that the
    /// payer can never be asked to fund more than the releases can consume.
    pub fn init(
        env: Env,
        agreement_id: u64,
        payer: Address,
        payee: Address,
        asset: Option<Address>,
        total_amount: i128,
        milestones: Vec<(String, i128)>,
        authorized: Address,
    ) -> Result<(), EscrowError> {
        let storage = env.storage().instance();
        if storage.has(&DataKey::Agreement) {
            return Err(EscrowError::AlreadyInitialized);
        }
        if total_amount <= 0 {
            return Err(EscrowError::InvalidAmount);
        }
        if milestones.is_empty() {
            return Err(EscrowError::InvalidMilestone);
        }
        // Do not invent an issuer/contract address for native XLM.
        if asset.is_none() {
            return Err(EscrowError::InvalidAsset);
        }

        let mut sum: i128 = 0;
        for i in 0..milestones.len() {
            let (description, amount) = milestones.get(i).unwrap();
            if description.is_empty() || amount <= 0 {
                return Err(EscrowError::InvalidAmount);
            }
            sum = sum.checked_add(amount).ok_or(EscrowError::InvalidAmount)?;
        }
        if sum != total_amount {
            return Err(EscrowError::InvalidAmount);
        }

        let agreement = Agreement {
            agreement_id,
            payer,
            payee,
            asset,
            total_amount,
            milestone_count: milestones.len(),
            funded: 0,
            released: 0,
            remaining: 0,
            authorized,
            status: Status::Created,
        };
        storage.set(&DataKey::Agreement, &agreement);

        for i in 0..milestones.len() {
            let (description, amount) = milestones.get(i).unwrap();
            let key = DataKey::Milestone(i);
            env.storage().persistent().set(
                &key,
                &Milestone {
                    index: i,
                    description,
                    amount,
                    approved: false,
                    released: false,
                },
            );
            extend_milestone_ttl(&env, i);
        }
        extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("init"), agreement_id),
            (
                agreement.payer.clone(),
                agreement.payee.clone(),
                total_amount,
                agreement.milestone_count,
            ),
        );
        Ok(())
    }

    /// Transfers `amount` of the agreed asset from the payer into escrow.
    /// The payer must authorize the call; only the payer may fund so that a
    /// refund can always return all escrowed value to the same party.
    pub fn fund(env: Env, from: Address, amount: i128) -> Result<(), EscrowError> {
        from.require_auth();
        let mut agreement = load_agreement(&env)?;
        if from != agreement.payer {
            return Err(EscrowError::Unauthorized);
        }
        if amount <= 0 {
            return Err(EscrowError::InvalidAmount);
        }
        if agreement.status == Status::Completed || agreement.status == Status::Refunded {
            return Err(EscrowError::InvalidState);
        }
        let new_funded = agreement
            .funded
            .checked_add(amount)
            .ok_or(EscrowError::InvalidAmount)?;
        if new_funded > agreement.total_amount {
            return Err(EscrowError::ExceedsTotal);
        }

        let asset = agreement.asset.clone().ok_or(EscrowError::InvalidAsset)?;
        TokenClient::new(&env, &asset).transfer(&from, &env.current_contract_address(), &amount);

        agreement.funded = new_funded;
        agreement.remaining = agreement
            .funded
            .checked_sub(agreement.released)
            .ok_or(EscrowError::InvalidState)?;
        agreement.status = Status::Funded;
        save_agreement(&env, &agreement);

        env.events().publish(
            (symbol_short!("funded"), agreement.agreement_id, from),
            (amount, agreement.funded),
        );
        Ok(())
    }

    /// Marks a milestone approved. Only the configured authorized party may do so.
    pub fn approve_milestone(
        env: Env,
        caller: Address,
        milestone_index: u32,
    ) -> Result<(), EscrowError> {
        caller.require_auth();
        let agreement = load_agreement(&env)?;
        if caller != agreement.authorized {
            return Err(EscrowError::Unauthorized);
        }
        if agreement.status == Status::Completed || agreement.status == Status::Refunded {
            return Err(EscrowError::InvalidState);
        }
        let mut milestone = load_milestone(&env, milestone_index)?;
        if milestone.approved {
            return Ok(());
        }
        milestone.approved = true;
        save_milestone(&env, &milestone);

        env.events().publish(
            (
                symbol_short!("approved"),
                agreement.agreement_id,
                milestone_index,
            ),
            milestone.amount,
        );
        Ok(())
    }

    /// Pays an approved milestone to the payee. Duplicate and over-release are
    /// rejected; the authorized party cannot drain more than was funded.
    pub fn release_milestone(
        env: Env,
        caller: Address,
        milestone_index: u32,
    ) -> Result<(), EscrowError> {
        caller.require_auth();
        let mut agreement = load_agreement(&env)?;
        if caller != agreement.authorized {
            return Err(EscrowError::Unauthorized);
        }
        if agreement.status == Status::Completed || agreement.status == Status::Refunded {
            return Err(EscrowError::InvalidState);
        }
        let mut milestone = load_milestone(&env, milestone_index)?;
        if milestone.released {
            return Err(EscrowError::AlreadyReleased);
        }
        if !milestone.approved {
            return Err(EscrowError::NotApproved);
        }
        if milestone.amount <= 0 {
            return Err(EscrowError::InvalidAmount);
        }
        if agreement.remaining < milestone.amount {
            return Err(EscrowError::InsufficientBalance);
        }

        let asset = agreement.asset.clone().ok_or(EscrowError::InvalidAsset)?;
        TokenClient::new(&env, &asset).transfer(
            &env.current_contract_address(),
            &agreement.payee,
            &milestone.amount,
        );

        milestone.released = true;
        save_milestone(&env, &milestone);

        agreement.released = agreement
            .released
            .checked_add(milestone.amount)
            .ok_or(EscrowError::InvalidAmount)?;
        agreement.remaining = agreement
            .remaining
            .checked_sub(milestone.amount)
            .ok_or(EscrowError::InsufficientBalance)?;
        if all_released(&env, &agreement)? {
            agreement.status = Status::Completed;
        }
        save_agreement(&env, &agreement);

        env.events().publish(
            (
                symbol_short!("released"),
                agreement.agreement_id,
                milestone_index,
            ),
            (milestone.amount, agreement.remaining),
        );
        Ok(())
    }

    /// Returns all remaining escrowed funds to the payer. Only allowed while
    /// no milestone has been released, and only by the payer or the authorized
    /// party. There is no admin-only withdrawal path.
    pub fn refund(env: Env, caller: Address) -> Result<(), EscrowError> {
        caller.require_auth();
        let mut agreement = load_agreement(&env)?;
        if caller != agreement.payer && caller != agreement.authorized {
            return Err(EscrowError::Unauthorized);
        }
        if agreement.status == Status::Completed || agreement.status == Status::Refunded {
            return Err(EscrowError::InvalidState);
        }
        if any_released(&env, &agreement)? {
            return Err(EscrowError::InvalidState);
        }
        if agreement.remaining <= 0 {
            return Err(EscrowError::InvalidState);
        }

        let asset = agreement.asset.clone().ok_or(EscrowError::InvalidAsset)?;
        let amount = agreement.remaining;
        TokenClient::new(&env, &asset).transfer(
            &env.current_contract_address(),
            &agreement.payer,
            &amount,
        );

        agreement.remaining = 0;
        agreement.status = Status::Refunded;
        save_agreement(&env, &agreement);

        env.events().publish(
            (
                symbol_short!("refunded"),
                agreement.agreement_id,
                agreement.payer.clone(),
            ),
            amount,
        );
        Ok(())
    }

    pub fn get_agreement(env: Env) -> Agreement {
        load_agreement(&env).unwrap_or_else(|e| panic_with_error!(&env, e))
    }

    pub fn get_milestone(env: Env, milestone_index: u32) -> Milestone {
        load_milestone(&env, milestone_index).unwrap_or_else(|e| panic_with_error!(&env, e))
    }

    pub fn get_balance(env: Env) -> BalanceInfo {
        let agreement = load_agreement(&env).unwrap_or_else(|e| panic_with_error!(&env, e));
        BalanceInfo {
            funded: agreement.funded,
            released: agreement.released,
            remaining: agreement.remaining,
        }
    }
}

fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
}

fn extend_milestone_ttl(env: &Env, index: u32) {
    env.storage().persistent().extend_ttl(
        &DataKey::Milestone(index),
        PERSISTENT_TTL_THRESHOLD,
        PERSISTENT_TTL_EXTEND,
    );
}

fn load_agreement(env: &Env) -> Result<Agreement, EscrowError> {
    env.storage()
        .instance()
        .get(&DataKey::Agreement)
        .ok_or(EscrowError::NotInitialized)
}

fn save_agreement(env: &Env, agreement: &Agreement) {
    env.storage().instance().set(&DataKey::Agreement, agreement);
    extend_instance_ttl(env);
}

fn load_milestone(env: &Env, index: u32) -> Result<Milestone, EscrowError> {
    let milestone = env
        .storage()
        .persistent()
        .get(&DataKey::Milestone(index))
        .ok_or(EscrowError::InvalidMilestone)?;
    extend_milestone_ttl(env, index);
    Ok(milestone)
}

fn save_milestone(env: &Env, milestone: &Milestone) {
    env.storage()
        .persistent()
        .set(&DataKey::Milestone(milestone.index), milestone);
    extend_milestone_ttl(env, milestone.index);
}

fn any_released(env: &Env, agreement: &Agreement) -> Result<bool, EscrowError> {
    for i in 0..agreement.milestone_count {
        if load_milestone(env, i)?.released {
            return Ok(true);
        }
    }
    Ok(false)
}

fn all_released(env: &Env, agreement: &Agreement) -> Result<bool, EscrowError> {
    for i in 0..agreement.milestone_count {
        if !load_milestone(env, i)?.released {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod test;
