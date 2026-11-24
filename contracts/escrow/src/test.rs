extern crate std;

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, String, Vec,
};

use crate::{BizflowEscrow, BizflowEscrowClient, EscrowError, Status};

const TOTAL: i128 = 1_000;

struct Fixture {
    env: Env,
    contract: Address,
    asset: Address,
    payer: Address,
    payee: Address,
    authorized: Address,
}

fn fixture() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let authorized = Address::generate(&env);
    let admin = Address::generate(&env);

    let contract = env.register(BizflowEscrow, ());
    let sac = env.register_stellar_asset_contract_v2(admin);
    let asset = sac.address();
    StellarAssetClient::new(&env, &asset).mint(&payer, &10_000);

    Fixture {
        env,
        contract,
        asset,
        payer,
        payee,
        authorized,
    }
}

fn client(f: &Fixture) -> BizflowEscrowClient<'static> {
    BizflowEscrowClient::new(&f.env, &f.contract)
}

fn milestones(env: &Env) -> Vec<(String, i128)> {
    Vec::from_array(
        env,
        [
            (String::from_str(env, "Discovery"), 300),
            (String::from_str(env, "Build"), 500),
            (String::from_str(env, "Launch"), 200),
        ],
    )
}

fn init(f: &Fixture) {
    client(f).init(
        &7u64,
        &f.payer,
        &f.payee,
        &Some(f.asset.clone()),
        &TOTAL,
        &milestones(&f.env),
        &f.authorized,
    );
}

fn token(f: &Fixture) -> TokenClient<'static> {
    TokenClient::new(&f.env, &f.asset)
}

#[test]
fn init_stores_agreement_and_milestones() {
    let f = fixture();
    init(&f);
    let c = client(&f);

    let a = c.get_agreement();
    assert_eq!(a.agreement_id, 7);
    assert_eq!(a.payer, f.payer);
    assert_eq!(a.payee, f.payee);
    assert_eq!(a.asset, Some(f.asset.clone()));
    assert_eq!(a.total_amount, TOTAL);
    assert_eq!(a.milestone_count, 3);
    assert_eq!(a.authorized, f.authorized);
    assert_eq!(a.status, Status::Created);

    let m0 = c.get_milestone(&0);
    assert_eq!(m0.description, String::from_str(&f.env, "Discovery"));
    assert_eq!(m0.amount, 300);
    assert!(!m0.approved);
    assert!(!m0.released);

    let balances = c.get_balance();
    assert_eq!(balances.funded, 0);
    assert_eq!(balances.released, 0);
    assert_eq!(balances.remaining, 0);
}

#[test]
fn init_twice_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    assert_eq!(
        c.try_init(
            &8u64,
            &f.payer,
            &f.payee,
            &Some(f.asset.clone()),
            &TOTAL,
            &milestones(&f.env),
            &f.authorized,
        ),
        Err(Ok(EscrowError::AlreadyInitialized))
    );
}

#[test]
fn init_rejects_milestone_sum_mismatch() {
    let f = fixture();
    let c = client(&f);
    let bad = Vec::from_array(&f.env, [(String::from_str(&f.env, "Only"), 999i128)]);
    assert_eq!(
        c.try_init(
            &1,
            &f.payer,
            &f.payee,
            &Some(f.asset.clone()),
            &TOTAL,
            &bad,
            &f.authorized,
        ),
        Err(Ok(EscrowError::InvalidAmount))
    );
}

#[test]
fn init_rejects_none_asset() {
    let f = fixture();
    let c = client(&f);
    assert_eq!(
        c.try_init(
            &1,
            &f.payer,
            &f.payee,
            &None,
            &TOTAL,
            &milestones(&f.env),
            &f.authorized,
        ),
        Err(Ok(EscrowError::InvalidAsset))
    );
}

#[test]
fn fund_transfers_tokens_and_updates_state() {
    let f = fixture();
    init(&f);
    let c = client(&f);

    c.fund(&f.payer, &600);
    assert_eq!(token(&f).balance(&f.contract), 600);
    assert_eq!(token(&f).balance(&f.payer), 10_000 - 600);

    let balances = c.get_balance();
    assert_eq!(balances.funded, 600);
    assert_eq!(balances.remaining, 600);
    assert_eq!(balances.released, 0);
    assert_eq!(c.get_agreement().status, Status::Funded);
}

#[test]
fn fund_rejects_non_payer() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    assert_eq!(
        c.try_fund(&f.payee, &100),
        Err(Ok(EscrowError::Unauthorized))
    );
    assert_eq!(token(&f).balance(&f.contract), 0);
}

#[test]
fn fund_rejects_zero_amount() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    assert_eq!(
        c.try_fund(&f.payer, &0),
        Err(Ok(EscrowError::InvalidAmount))
    );
}

#[test]
fn fund_rejects_amount_exceeding_total() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    assert_eq!(c.try_fund(&f.payer, &1), Err(Ok(EscrowError::ExceedsTotal)));
    assert_eq!(token(&f).balance(&f.contract), TOTAL);
}

#[test]
fn approve_milestone_by_authorized_party() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.approve_milestone(&f.authorized, &1);
    assert!(c.get_milestone(&1).approved);
    assert!(!c.get_milestone(&0).approved);
}

#[test]
fn approve_milestone_by_unauthorized_party_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    assert_eq!(
        c.try_approve_milestone(&f.payer, &0),
        Err(Ok(EscrowError::Unauthorized))
    );
    assert!(!c.get_milestone(&0).approved);
}

#[test]
fn approve_milestone_invalid_index_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    assert_eq!(
        c.try_approve_milestone(&f.authorized, &99),
        Err(Ok(EscrowError::InvalidMilestone))
    );
}

#[test]
fn release_milestone_transfers_to_payee() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    c.approve_milestone(&f.authorized, &0);
    c.release_milestone(&f.authorized, &0);

    assert_eq!(token(&f).balance(&f.payee), 300);
    assert_eq!(token(&f).balance(&f.contract), TOTAL - 300);
    assert!(c.get_milestone(&0).released);

    let balances = c.get_balance();
    assert_eq!(balances.funded, TOTAL);
    assert_eq!(balances.released, 300);
    assert_eq!(balances.remaining, TOTAL - 300);
    assert_eq!(c.get_agreement().status, Status::Funded);
}

#[test]
fn release_by_unauthorized_party_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    c.approve_milestone(&f.authorized, &0);
    assert_eq!(
        c.try_release_milestone(&f.payee, &0),
        Err(Ok(EscrowError::Unauthorized))
    );
    assert_eq!(token(&f).balance(&f.payee), 0);
}

#[test]
fn release_without_approval_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    assert_eq!(
        c.try_release_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::NotApproved))
    );
    assert_eq!(token(&f).balance(&f.payee), 0);
}

#[test]
fn duplicate_release_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    c.approve_milestone(&f.authorized, &0);
    c.release_milestone(&f.authorized, &0);
    assert_eq!(
        c.try_release_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::AlreadyReleased))
    );
    assert_eq!(token(&f).balance(&f.payee), 300);
}

#[test]
fn release_with_insufficient_balance_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &100);
    c.approve_milestone(&f.authorized, &0);
    assert_eq!(
        c.try_release_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::InsufficientBalance))
    );
    assert_eq!(token(&f).balance(&f.payee), 0);
    assert_eq!(c.get_balance().remaining, 100);
}

#[test]
fn refund_by_payer_returns_all_funds() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &400);
    c.refund(&f.payer);

    assert_eq!(token(&f).balance(&f.contract), 0);
    assert_eq!(token(&f).balance(&f.payer), 10_000);
    assert_eq!(c.get_agreement().status, Status::Refunded);
    assert_eq!(c.get_balance().remaining, 0);
}

#[test]
fn refund_by_authorized_party_is_allowed() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &400);
    c.refund(&f.authorized);
    assert_eq!(token(&f).balance(&f.payer), 10_000);
    assert_eq!(c.get_agreement().status, Status::Refunded);
}

#[test]
fn refund_by_unrelated_party_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &400);
    let stranger = Address::generate(&f.env);
    assert_eq!(c.try_refund(&stranger), Err(Ok(EscrowError::Unauthorized)));
    assert_eq!(token(&f).balance(&f.contract), 400);
}

#[test]
fn refund_after_a_release_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    c.approve_milestone(&f.authorized, &0);
    c.release_milestone(&f.authorized, &0);
    assert_eq!(c.try_refund(&f.payer), Err(Ok(EscrowError::InvalidState)));
    assert_eq!(token(&f).balance(&f.contract), TOTAL - 300);
}

#[test]
fn refund_without_funds_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    assert_eq!(c.try_refund(&f.payer), Err(Ok(EscrowError::InvalidState)));
}

#[test]
fn full_lifecycle_completes_and_is_locked() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    for i in 0..3 {
        c.approve_milestone(&f.authorized, &i);
        c.release_milestone(&f.authorized, &i);
    }

    assert_eq!(c.get_agreement().status, Status::Completed);
    let balances = c.get_balance();
    assert_eq!(balances.funded, TOTAL);
    assert_eq!(balances.released, TOTAL);
    assert_eq!(balances.remaining, 0);
    assert_eq!(token(&f).balance(&f.payee), TOTAL);
    assert_eq!(token(&f).balance(&f.contract), 0);

    assert_eq!(c.try_refund(&f.payer), Err(Ok(EscrowError::InvalidState)));
    assert_eq!(c.try_fund(&f.payer, &1), Err(Ok(EscrowError::InvalidState)));
}

#[test]
fn init_and_fund_emit_events() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &500);

    let events = f.env.events().all().filter_by_contract(&f.contract);
    let expected = vec![
        &f.env,
        (
            f.contract.clone(),
            vec![
                &f.env,
                symbol_short!("funded").into_val(&f.env),
                7u64.into_val(&f.env),
                f.payer.clone().into_val(&f.env),
            ],
            (500i128, 500i128).into_val(&f.env),
        ),
    ];
    assert_eq!(events, expected);
}

#[test]
fn approval_and_release_emit_events() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    c.approve_milestone(&f.authorized, &0);
    c.release_milestone(&f.authorized, &0);

    let events = f.env.events().all().filter_by_contract(&f.contract);
    let expected = vec![
        &f.env,
        (
            f.contract.clone(),
            vec![
                &f.env,
                symbol_short!("released").into_val(&f.env),
                7u64.into_val(&f.env),
                0u32.into_val(&f.env),
            ],
            (300i128, 700i128).into_val(&f.env),
        ),
    ];
    assert_eq!(events, expected);
}

// ---------------------------------------------------------------------------
// Additional coverage: validation branches, defensive state, getters, events.
// ---------------------------------------------------------------------------

use crate::{Agreement, DataKey, Milestone};
use soroban_sdk::xdr::ScVal;
use std::convert::TryFrom;

fn set_agreement(f: &Fixture, agreement: Agreement) {
    f.env.as_contract(&f.contract, || {
        f.env
            .storage()
            .instance()
            .set(&DataKey::Agreement, &agreement);
    });
}

fn set_milestone(f: &Fixture, milestone: Milestone) {
    f.env.as_contract(&f.contract, || {
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Milestone(milestone.index), &milestone);
    });
}

fn remove_milestone(f: &Fixture, index: u32) {
    f.env.as_contract(&f.contract, || {
        f.env
            .storage()
            .persistent()
            .remove(&DataKey::Milestone(index));
    });
}

#[test]
fn init_rejects_non_positive_total() {
    let f = fixture();
    let c = client(&f);
    for total in [0i128, -1i128] {
        assert_eq!(
            c.try_init(
                &1,
                &f.payer,
                &f.payee,
                &Some(f.asset.clone()),
                &total,
                &milestones(&f.env),
                &f.authorized,
            ),
            Err(Ok(EscrowError::InvalidAmount))
        );
    }
}

#[test]
fn init_rejects_empty_milestones() {
    let f = fixture();
    let c = client(&f);
    let empty: Vec<(String, i128)> = Vec::new(&f.env);
    assert_eq!(
        c.try_init(
            &1,
            &f.payer,
            &f.payee,
            &Some(f.asset.clone()),
            &TOTAL,
            &empty,
            &f.authorized,
        ),
        Err(Ok(EscrowError::InvalidMilestone))
    );
}

#[test]
fn init_rejects_empty_description_and_non_positive_amount() {
    let f = fixture();
    let c = client(&f);
    let empty_desc = Vec::from_array(
        &f.env,
        [(String::from_str(&f.env, ""), 100i128), (String::from_str(&f.env, "Ok"), 900i128)],
    );
    assert_eq!(
        c.try_init(
            &1,
            &f.payer,
            &f.payee,
            &Some(f.asset.clone()),
            &TOTAL,
            &empty_desc,
            &f.authorized,
        ),
        Err(Ok(EscrowError::InvalidAmount))
    );

    let f2 = fixture();
    let c2 = client(&f2);
    let zero_amount = Vec::from_array(
        &f2.env,
        [(String::from_str(&f2.env, "Zero"), 0i128), (String::from_str(&f2.env, "Ok"), TOTAL)],
    );
    assert_eq!(
        c2.try_init(
            &1,
            &f2.payer,
            &f2.payee,
            &Some(f2.asset.clone()),
            &TOTAL,
            &zero_amount,
            &f2.authorized,
        ),
        Err(Ok(EscrowError::InvalidAmount))
    );
}

#[test]
fn init_rejects_milestone_sum_overflow() {
    let f = fixture();
    let c = client(&f);
    let overflowing = Vec::from_array(
        &f.env,
        [
            (String::from_str(&f.env, "Max"), i128::MAX),
            (String::from_str(&f.env, "One"), 1i128),
        ],
    );
    assert_eq!(
        c.try_init(
            &1,
            &f.payer,
            &f.payee,
            &Some(f.asset.clone()),
            &TOTAL,
            &overflowing,
            &f.authorized,
        ),
        Err(Ok(EscrowError::InvalidAmount))
    );
}

#[test]
fn uninitialized_calls_fail_and_getters_panic_with_error() {
    let f = fixture();
    let c = client(&f);
    assert_eq!(c.try_fund(&f.payer, &1), Err(Ok(EscrowError::NotInitialized)));
    assert_eq!(
        c.try_approve_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::NotInitialized))
    );
    assert_eq!(
        c.try_release_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::NotInitialized))
    );
    assert_eq!(c.try_refund(&f.payer), Err(Ok(EscrowError::NotInitialized)));
    assert_eq!(
        c.try_get_agreement().unwrap_err().unwrap(),
        EscrowError::NotInitialized.into()
    );
    assert_eq!(
        c.try_get_milestone(&0).unwrap_err().unwrap(),
        EscrowError::InvalidMilestone.into()
    );
    assert_eq!(
        c.try_get_balance().unwrap_err().unwrap(),
        EscrowError::NotInitialized.into()
    );
}

#[test]
fn duplicate_approval_is_noop_and_emits_no_event() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.approve_milestone(&f.authorized, &0);
    c.approve_milestone(&f.authorized, &0);
    assert!(c.get_milestone(&0).approved);
    assert_eq!(f.env.events().all().filter_by_contract(&f.contract).events().is_empty(), true);
}

#[test]
fn approval_and_release_in_terminal_states_fail() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &400);
    c.refund(&f.payer);
    assert_eq!(
        c.try_approve_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::InvalidState))
    );
    assert_eq!(
        c.try_release_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::InvalidState))
    );
}

#[test]
fn approve_after_completion_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    for i in 0..3 {
        c.approve_milestone(&f.authorized, &i);
        c.release_milestone(&f.authorized, &i);
    }
    assert_eq!(
        c.try_approve_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::InvalidState))
    );
    assert_eq!(
        c.try_release_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::InvalidState))
    );
}

#[test]
fn refund_twice_fails() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &400);
    c.refund(&f.payer);
    assert_eq!(c.try_refund(&f.payer), Err(Ok(EscrowError::InvalidState)));
    assert_eq!(token(&f).balance(&f.payer), 10_000);
}

#[test]
fn release_rejects_invalid_index() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    assert_eq!(
        c.try_release_milestone(&f.authorized, &99),
        Err(Ok(EscrowError::InvalidMilestone))
    );
    assert_eq!(token(&f).balance(&f.contract), TOTAL);
}

#[test]
fn release_rejects_corrupt_non_positive_milestone_amount() {
    let f = fixture();
    init(&f);
    let mut m = client(&f).get_milestone(&0);
    m.amount = 0;
    set_milestone(&f, m);
    client(&f).fund(&f.payer, &TOTAL);
    client(&f).approve_milestone(&f.authorized, &0);
    assert_eq!(
        client(&f).try_release_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::InvalidAmount))
    );
    assert_eq!(token(&f).balance(&f.payee), 0);
}

#[test]
fn fund_rejects_missing_asset_in_stored_agreement() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    let mut a = c.get_agreement();
    a.asset = None;
    set_agreement(&f, a);
    assert_eq!(c.try_fund(&f.payer, &100), Err(Ok(EscrowError::InvalidAsset)));
    assert_eq!(token(&f).balance(&f.contract), 0);
}

#[test]
fn fund_rejects_overflowing_total() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    let mut a = c.get_agreement();
    a.funded = i128::MAX;
    a.total_amount = i128::MAX;
    set_agreement(&f, a);
    assert_eq!(c.try_fund(&f.payer, &1), Err(Ok(EscrowError::InvalidAmount)));
    assert_eq!(token(&f).balance(&f.contract), 0);
}

#[test]
fn fund_rejects_underflow_when_released_exceeds_funded() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    let mut a = c.get_agreement();
    a.funded = i128::MIN;
    a.released = i128::MAX;
    a.remaining = 0;
    set_agreement(&f, a);
    assert_eq!(c.try_fund(&f.payer, &1), Err(Ok(EscrowError::InvalidState)));
    assert_eq!(c.get_balance().funded, i128::MIN);
}

#[test]
fn release_rejects_missing_asset_in_stored_agreement() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    c.approve_milestone(&f.authorized, &0);
    let mut a = c.get_agreement();
    a.asset = None;
    set_agreement(&f, a);
    assert_eq!(
        c.try_release_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::InvalidAsset))
    );
    assert_eq!(token(&f).balance(&f.payee), 0);
}

#[test]
fn release_rejects_overflowing_released_total() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.approve_milestone(&f.authorized, &0);
    let mut a = c.get_agreement();
    a.funded = i128::MAX;
    a.released = i128::MAX;
    a.remaining = i128::MAX;
    a.total_amount = i128::MAX;
    set_agreement(&f, a);
    StellarAssetClient::new(&f.env, &f.asset).mint(&f.contract, &300);
    assert_eq!(
        c.try_release_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::InvalidAmount))
    );
    assert_eq!(token(&f).balance(&f.payee), 0);
}

#[test]
fn release_propagates_missing_milestone_error() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &TOTAL);
    c.approve_milestone(&f.authorized, &0);
    remove_milestone(&f, 1);
    assert_eq!(
        c.try_release_milestone(&f.authorized, &0),
        Err(Ok(EscrowError::InvalidMilestone))
    );
    assert!(!c.get_milestone(&0).released);
    assert_eq!(c.get_balance().released, 0);
}

#[test]
fn refund_propagates_missing_milestone_error() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &400);
    remove_milestone(&f, 1);
    assert_eq!(c.try_refund(&f.payer), Err(Ok(EscrowError::InvalidMilestone)));
    assert_eq!(token(&f).balance(&f.contract), 400);
}

#[test]
fn refund_rejects_missing_asset_in_stored_agreement() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &400);
    let mut a = c.get_agreement();
    a.asset = None;
    set_agreement(&f, a);
    assert_eq!(c.try_refund(&f.payer), Err(Ok(EscrowError::InvalidAsset)));
    assert_eq!(token(&f).balance(&f.contract), 400);
}

#[test]
fn init_emits_event() {
    let f = fixture();
    init(&f);
    let events = f.env.events().all().filter_by_contract(&f.contract);
    let payer: soroban_sdk::Val = f.payer.clone().into_val(&f.env);
    let payee: soroban_sdk::Val = f.payee.clone().into_val(&f.env);
    let total: soroban_sdk::Val = TOTAL.into_val(&f.env);
    let count: soroban_sdk::Val = 3u32.into_val(&f.env);
    let expected = vec![
        &f.env,
        (
            f.contract.clone(),
            vec![&f.env, symbol_short!("init").into_val(&f.env), 7u64.into_val(&f.env)],
            (payer, payee, total, count).into_val(&f.env),
        ),
    ];
    assert_eq!(events, expected);
}

#[test]
fn approval_emits_event() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.approve_milestone(&f.authorized, &1);
    let events = f.env.events().all().filter_by_contract(&f.contract);
    let expected = vec![
        &f.env,
        (
            f.contract.clone(),
            vec![
                &f.env,
                symbol_short!("approved").into_val(&f.env),
                7u64.into_val(&f.env),
                1u32.into_val(&f.env),
            ],
            500i128.into_val(&f.env),
        ),
    ];
    assert_eq!(events, expected);
}

#[test]
fn refund_emits_event() {
    let f = fixture();
    init(&f);
    let c = client(&f);
    c.fund(&f.payer, &400);
    c.refund(&f.payer);
    let events = f.env.events().all().filter_by_contract(&f.contract);
    let expected = vec![
        &f.env,
        (
            f.contract.clone(),
            vec![
                &f.env,
                symbol_short!("refunded").into_val(&f.env),
                7u64.into_val(&f.env),
                f.payer.clone().into_val(&f.env),
            ],
            400i128.into_val(&f.env),
        ),
    ];
    assert_eq!(events, expected);
}

#[test]
fn contract_types_convert_to_xdr_scval() {
    let f = fixture();
    init(&f);
    let c = client(&f);

    // `#[contracttype]` also generates testutils-only XDR conversions.
    let _: ScVal = ScVal::try_from(&c.get_agreement()).unwrap();
    let _: ScVal = ScVal::try_from(&c.get_milestone(&0)).unwrap();
    let _: ScVal = ScVal::try_from(&c.get_balance()).unwrap();
    let _: ScVal = ScVal::try_from(&Status::Created).unwrap();
    let _: ScVal = ScVal::try_from(&DataKey::Agreement).unwrap();
    let _: ScVal = ScVal::try_from(&DataKey::Milestone(0)).unwrap();
}


