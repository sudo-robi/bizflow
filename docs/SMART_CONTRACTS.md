# Smart Contracts

## BizFlow milestone escrow

Source: `contracts/escrow/`. Language: Rust with `soroban-sdk` 30.0.0.
One deployed instance holds exactly one agreement, which keeps the authorization
model simple and prevents cross-agreement fund mixing.

### State

```text
Agreement {
  agreement_id: u64, payer: Address, payee: Address,
  asset: Option<Address>, total_amount: i128,
  milestone_count: u32, funded: i128, released: i128,
  remaining: i128, authorized: Address, status: Status
}
Milestone { index: u32, description: String, amount: i128, approved: bool, released: bool }
Status   = Created | Funded | Completed | Refunded
```

### Functions

| Function | Authorization | Behavior / guards |
|---|---|---|
| `init` | once per instance | validates positive amounts, non-empty milestones whose amounts sum exactly to `total_amount`, requires a real SAC address (native XLM must be wrapped, never invented) |
| `fund(from, amount)` | payer only | calls the SAC `transfer` into the contract, accumulates `funded`, rejects exceeding `total_amount`, emits `funded` |
| `approve_milestone(caller, index)` | authorized party only | requires initialized/funded state and a valid milestone, emits `approved` |
| `release_milestone(caller, index)` | authorized party only | requires approved, not already released, and `remaining >= amount`; transfers to payee via SAC, updates `released`/`remaining`, emits `released`; rejects duplicates and over-release |
| `refund(caller)` | payer or authorized party | only while **no** milestone has been released; returns remaining funds to payer and marks `Refunded`. There is no admin withdrawal path. |
| `get_agreement`, `get_milestone`, `get_balance` | public reads | return on-chain state |

### Errors

`AlreadyInitialized(1)`, `NotInitialized(2)`, `Unauthorized(3)`, `InvalidAmount(4)`,
`InvalidMilestone(5)`, `InvalidState(6)`, `InsufficientBalance(7)`, `AlreadyReleased(8)`,
`NotApproved(9)`, `ExceedsTotal(10)`, `InvalidAsset(11)`.

### Events

`init`, `funded`, `approved`, `released`, `refunded` (plus SAC `transfer` events), each
carrying the agreement id so off-chain verification can correlate them.

### Build and test

```bash
cd contracts/escrow
cargo test                                # 24 tests, all passing
rustup target add wasm32v1-none           # SDK 30 does not support wasm32-unknown-unknown on Rust 1.84+
stellar contract build                    # optimized wasm
```

`cargo build --target wasm32-unknown-unknown --release` intentionally fails with the
SDK's guard directing use of `wasm32v1-none`; use `stellar contract build` as above.

### Test coverage

Funding, milestone release, unauthorized release, duplicate release, insufficient
balance, invalid state/approval, refund rules, amount-sum validation, one-shot init and
event emission — 24 tests using a real registered Stellar Asset Contract in the test
environment.

### Deployment

The contract has been deployed to **Stellar Testnet**. The real contract id, WASM hash,
transaction hashes and live state readback are recorded in `TESTNET_DEPLOYMENT.md`.
Do not hardcode a different or invented id; read `STELLAR_ESCROW_CONTRACT_ID` from the
environment. Deployment to mainnet is not part of this project and is disabled by the
backend's Testnet-only guard.

### Security notes

- Funds can only leave the contract through `release_milestone` to the designated payee
  or `refund` to the payer, and only under the guards above.
- The authorized party cannot release more than was funded; the contract never exposes a
  generic admin withdrawal.
- Asset addresses are explicit; native XLM uses its real derived SAC address.
- All state transitions emit events, enabling independent verification via Soroban RPC.
