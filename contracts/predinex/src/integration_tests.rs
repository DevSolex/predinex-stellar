//! End-to-end integration tests for the full bet lifecycle.
//!
//! Unlike the focused unit tests in `test.rs`, these exercise complete
//! cross-function flows — create → bet → resolve → claim — for both single-
//! and multi-outcome pools, plus the cancellation/refund and claim-after-expiry
//! paths. They also assert that each lifecycle transition emits its Soroban
//! event so off-chain indexers can reconstruct state from the event stream.

#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::String;
use soroban_sdk::{
    testutils::Address as _, testutils::Events, testutils::Ledger, Address, Env, Symbol, TryFromVal,
};

/// A funded test fixture: an initialized contract plus a mintable token.
struct Fixture {
    env: Env,
    client: PredinexContractClient<'static>,
    token: token::Client<'static>,
    token_admin_client: token::StellarAssetClient<'static>,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(PredinexContract, ());
    let client = PredinexContractClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token::Client::new(&env, &token_id.address());
    let token_admin_client = token::StellarAssetClient::new(&env, &token_id.address());

    client.initialize(&token_id.address(), &token_admin);

    Fixture {
        env,
        client,
        token,
        token_admin_client,
    }
}

/// Returns `true` if any event from the *most recent* contract invocation
/// carries `name` as its first topic.
///
/// The Soroban test host keeps only the latest top-level invocation's events in
/// `env.events().all()`, so callers must assert immediately after the call that
/// is expected to emit the event. Scanning all topics (rather than a fixed
/// position) keeps the check robust and ignores the unrelated token-contract
/// events that also land in `env.events()`.
fn event_emitted(env: &Env, name: &str) -> bool {
    let target = Symbol::new(env, name);
    for event in env.events().all().iter() {
        let topics = event.1;
        if let Some(first) = topics.get(0) {
            if let Ok(sym) = Symbol::try_from_val(env, &first) {
                if sym == target {
                    return true;
                }
            }
        }
    }
    false
}

/// Single-asset (binary) pool: create → two bets → settle → winner claims.
#[test]
fn single_asset_pool_full_lifecycle() {
    let f = setup();
    let creator = Address::generate(&f.env);
    let winner = Address::generate(&f.env);
    let loser = Address::generate(&f.env);

    f.token_admin_client.mint(&winner, &1000);
    f.token_admin_client.mint(&loser, &1000);

    let pool_id = f.client.create_pool(
        &creator,
        &String::from_str(&f.env, "Will it rain tomorrow?"),
        &String::from_str(&f.env, "Resolves yes if rain is recorded."),
        &String::from_str(&f.env, "Yes"),
        &String::from_str(&f.env, "No"),
        &3600,
    );
    assert!(event_emitted(&f.env, "create_pool"));

    // Both sides take an equal position.
    f.client.place_bet(&winner, &pool_id, &0, &100, &None::<Address>);
    assert!(event_emitted(&f.env, "place_bet"));
    f.client.place_bet(&loser, &pool_id, &1, &100, &None::<Address>);

    assert_eq!(f.client.get_participant_count(&pool_id), 2);
    assert_eq!(f.token.balance(&winner), 900);

    // Advance past expiry and resolve outcome 0 (Yes) as the winner.
    f.env.ledger().with_mut(|li| li.timestamp = 3601);
    f.client.settle_pool(&creator, &pool_id, &0);
    assert!(event_emitted(&f.env, "settle_pool"));

    let pool = f.client.get_pool(&pool_id).unwrap();
    assert_eq!(pool.status, PoolStatus::Settled(0));

    // Pool total = 200, 2% fee = 4, net = 196. Sole winner takes the lot.
    // (Assert the event before any token read — each contract invocation resets
    // the test host's per-invocation event buffer.)
    let winnings = f.client.claim_winnings(&winner, &pool_id);
    assert!(event_emitted(&f.env, "claim_winnings"));
    assert_eq!(winnings, 196);
    assert_eq!(f.token.balance(&winner), 900 + 196);
}

/// Multi-outcome pool: create with three outcomes → bets on each → settle →
/// the winning-side bettor claims the whole net pool end-to-end.
#[test]
fn multi_asset_pool_full_lifecycle() {
    let f = setup();
    let creator = Address::generate(&f.env);
    let better_a = Address::generate(&f.env);
    let better_b = Address::generate(&f.env);
    let better_c = Address::generate(&f.env);

    for who in [&better_a, &better_b, &better_c] {
        f.token_admin_client.mint(who, &1000);
    }

    let mut outcomes = soroban_sdk::Vec::new(&f.env);
    outcomes.push_back(String::from_str(&f.env, "Team A"));
    outcomes.push_back(String::from_str(&f.env, "Team B"));
    outcomes.push_back(String::from_str(&f.env, "Draw"));

    let pool_id = f.client.create_multi_outcome_pool(
        &creator,
        &String::from_str(&f.env, "Who wins the match?"),
        &String::from_str(&f.env, "Three-way market with a draw option."),
        &outcomes,
        &3600,
        &None::<String>,
    );
    assert!(event_emitted(&f.env, "create_pool"));

    // One bettor per outcome, equal stakes.
    f.client.place_bet(&better_a, &pool_id, &0, &100, &None::<Address>);
    f.client.place_bet(&better_b, &pool_id, &1, &100, &None::<Address>);
    f.client.place_bet(&better_c, &pool_id, &2, &100, &None::<Address>);

    // The pool really tracks three distinct outcomes with their totals.
    let pool_outcomes = f.client.get_pool_outcomes(&pool_id);
    assert_eq!(pool_outcomes.len(), 3);
    assert_eq!(pool_outcomes.get(2).unwrap().total, 100);

    f.env.ledger().with_mut(|li| li.timestamp = 3601);
    // Outcome 2 (Draw) wins.
    f.client.settle_pool(&creator, &pool_id, &2);
    assert!(event_emitted(&f.env, "settle_pool"));

    // Pool total = 300, 2% fee = 6, net = 294, single winner on outcome 2.
    let winnings = f.client.claim_winnings(&better_c, &pool_id);
    assert!(event_emitted(&f.env, "claim_winnings"));
    assert_eq!(winnings, 294);
    assert_eq!(f.token.balance(&better_c), 900 + 294);

    // A losing-side bettor has nothing to claim.
    assert!(f.client.try_claim_winnings(&better_a, &pool_id).is_err());
}

/// Cancellation + refund: creator cancels an open pool and the bettor recovers
/// their full stake with no fee deducted.
#[test]
fn cancellation_and_refund_flow() {
    let f = setup();
    let creator = Address::generate(&f.env);
    let bettor = Address::generate(&f.env);

    f.token_admin_client.mint(&bettor, &1000);

    let pool_id = f.client.create_pool(
        &creator,
        &String::from_str(&f.env, "Will the launch ship on time?"),
        &String::from_str(&f.env, "Resolves yes on an on-time launch."),
        &String::from_str(&f.env, "Yes"),
        &String::from_str(&f.env, "No"),
        &3600,
    );

    f.client.place_bet(&bettor, &pool_id, &0, &250, &None::<Address>);
    assert_eq!(f.token.balance(&bettor), 750);

    // Creator voids the market by cancelling it while still open.
    f.client.cancel_pool(&creator, &pool_id);
    assert!(event_emitted(&f.env, "cancel_pool"));
    assert_eq!(
        f.client.get_pool(&pool_id).unwrap().status,
        PoolStatus::Cancelled
    );

    // The bettor reclaims the original stake in full — no protocol fee.
    let refund = f.client.claim_refund(&bettor, &pool_id);
    assert!(event_emitted(&f.env, "claim_refund"));
    assert_eq!(refund, 250);
    assert_eq!(f.token.balance(&bettor), 1000);

    // A second refund attempt fails because the bet record was removed.
    assert!(f.client.try_claim_refund(&bettor, &pool_id).is_err());
}

/// Claim after expiry: a pool expires without ever being settled, and the
/// bettor recovers their full stake via `claim_expired`.
#[test]
fn claim_after_expiry_flow() {
    let f = setup();
    let creator = Address::generate(&f.env);
    let bettor = Address::generate(&f.env);

    f.token_admin_client.mint(&bettor, &1000);

    let pool_id = f.client.create_pool(
        &creator,
        &String::from_str(&f.env, "Abandoned market"),
        &String::from_str(&f.env, "Creator never settles this one."),
        &String::from_str(&f.env, "Yes"),
        &String::from_str(&f.env, "No"),
        &3600,
    );
    assert!(event_emitted(&f.env, "create_pool"));

    f.client.place_bet(&bettor, &pool_id, &1, &400, &None::<Address>);
    assert_eq!(f.token.balance(&bettor), 600);

    // Move strictly past expiry; the creator never calls settle_pool.
    f.env.ledger().with_mut(|li| li.timestamp = 3601);

    // Funds would otherwise be stuck — claim_expired returns the stake in full.
    let refund = f.client.claim_expired(&bettor, &pool_id);
    assert!(event_emitted(&f.env, "claim_expired"));
    assert_eq!(refund, 400);
    assert_eq!(f.token.balance(&bettor), 1000);

    // The position is gone, so a repeat claim fails.
    assert!(f.client.try_claim_expired(&bettor, &pool_id).is_err());
}
