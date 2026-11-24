# BizFlow Soroban escrow contract

One deployed contract instance = one agreement. The `agreement_id` passed to
`init` is a unique u64 chosen by BizFlow, stored on-chain, and included in every
event. All token amounts are `i128` **stroops** (1 XLM = 10_000_000).

## Security model

- `init` is one-shot; milestone amounts must sum **exactly** to `total_amount`.
- The agreed `asset` is a **Stellar Asset Contract (SAC) address**. Native XLM
  must be wrapped in its SAC and that real address supplied. `None` is rejected
  with `InvalidAsset`: the contract never invents an issuer or contract address.
- Only the payer may fund (`from.require_auth()` + `from == payer`), so escrowed
  value can always be refunded to the same party.
- Only the configured `authorized` address (payer or a designated approver) can
  approve and release milestones; every mutating call requires `require_auth`.
- Release requires funded balance, approval, and no prior release of that
  milestone. Duplicate release and over-release are rejected.
- `refund` is only callable by the payer or the authorized party, only while no
  milestone has been released. There is **no admin-only withdrawal path**.
- Statuses: `Created` → `Funded` → `Completed`, or `Created`/`Funded` → `Refunded`.
- Events: `init`, `funded`, `approved`, `released`, `refunded` (topics begin with
  the event name and agreement id; amounts are in the data).
- Persistent milestone entries and the agreement instance have TTL extension
  helpers; keep the contract/instance alive with normal Soroban TTL bumps.

## Error codes (`EscrowError`)

| Code | Name |
|------|------|
| 1 | `AlreadyInitialized` |
| 2 | `NotInitialized` |
| 3 | `Unauthorized` |
| 4 | `InvalidAmount` |
| 5 | `InvalidMilestone` |
| 6 | `InvalidState` |
| 7 | `InsufficientBalance` |
| 8 | `AlreadyReleased` |
| 9 | `NotApproved` |
| 10 | `ExceedsTotal` |
| 11 | `InvalidAsset` |

## Build and test (standalone crate, no workspace)

From the repository root:

```bash
cd contracts/escrow
cargo test                                   # runs the full test suite
cargo build --release                        # native rlib/cdylib (not deployable)
```

WASM note: `soroban-sdk` 30 **refuses** `wasm32-unknown-unknown` with Rust ≥ 1.82
(it enables unsupported WASM features). Use `wasm32v1-none` or let the CLI pick
the target. A raw `cargo build` for a wasm target also requires a
`STELLAR_CLI_VERSION` of at least 30 because SDK 30 needs CLI-driven spec
shaking:

```bash
rustup target add wasm32v1-none
STELLAR_CLI_VERSION=30.0.1 cargo build --target wasm32v1-none --release
```

**Preferred:** use the Stellar CLI (v30+), which selects the correct target,
runs spec shaking, and prints the final WASM path. CLI v30 also requires
`overflow-checks = true` in `[profile.release]` (already set in this crate):

```bash
cd contracts/escrow
stellar contract build
```

The resulting file is under `target/wasm32v1-none/release/` (use the path printed
by `stellar contract build`).

## Deploy to TESTNET

> **DO NOT invent or hardcode a contract ID.** There is no pre-deployed ID in
> this repository. Deploy from a funded testnet account, copy the **real** ID
> printed by `stellar contract deploy`, and export it as
> `STELLAR_ESCROW_CONTRACT_ID` for all later commands. Never commit a fake ID or
> transaction hash.

Prerequisites: a funded testnet source account (e.g. `stellar keys generate
--network testnet my-testnet-account` followed by `stellar keys fund
--network testnet my-testnet-account`), and a real SAC address for the agreed
asset.

```bash
cd contracts/escrow

# 1. Build (regenerate the WASM after any source change)
stellar contract build

# 2. Deploy — the command prints the new contract ID (C...)
stellar contract deploy \
  --network testnet \
  --source my-testnet-account \
  --wasm target/wasm32v1-none/release/bizflow_escrow.wasm

# 3. Record the REAL ID returned above (example placeholder only — replace it)
export STELLAR_ESCROW_CONTRACT_ID="<paste the C... ID printed by deploy>"
```

If an asset SAC does not exist yet, deploy one first with `stellar asset deploy`
(or use an existing SAC) and use its real address as `--asset` below. Native XLM
must be wrapped this way; do not pass `native`/`none`.

## Initialize one agreement per deployed contract

Amounts below are examples in stroops (10 XLM total = 100_000_000). Milestone
amounts must sum exactly to `--total-amount`.

```bash
stellar contract invoke \
  --network testnet \
  --source my-testnet-account \
  --id "$STELLAR_ESCROW_CONTRACT_ID" \
  -- init \
  --agreement-id 1 \
  --payer <PAYER_ADDRESS> \
  --payee <PAYEE_ADDRESS> \
  --asset <REAL_SAC_CONTRACT_ADDRESS> \
  --total-amount 100000000 \
  --milestones '[{"description":"Discovery","amount":30000000},{"description":"Build","amount":50000000},{"description":"Launch","amount":20000000}]' \
  --authorized <AUTHORIZED_ADDRESS>
```

If the CLI rejects the JSON form of `Vec<(String,i128)>`, run
`stellar contract invoke ... -- init --help` and use the exact syntax it prints
for tuple vectors. Repeating `init` returns `AlreadyInitialized`.

## Operating the agreement

```bash
# Payer must sign; payer holds the asset SAC token.
stellar contract invoke --network testnet --source <PAYER> \
  --id "$STELLAR_ESCROW_CONTRACT_ID" -- fund --from <PAYER> --amount 100000000

# Authorized party approves milestone 0, then releases it to the payee.
stellar contract invoke --network testnet --source <AUTHORIZED> \
  --id "$STELLAR_ESCROW_CONTRACT_ID" -- approve_milestone --caller <AUTHORIZED> --milestone-index 0

stellar contract invoke --network testnet --source <AUTHORIZED> \
  --id "$STELLAR_ESCROW_CONTRACT_ID" -- release_milestone --caller <AUTHORIZED> --milestone-index 0

# Before any release: payer or authorized party gets all remaining funds back.
stellar contract invoke --network testnet --source <PAYER> \
  --id "$STELLAR_ESCROW_CONTRACT_ID" -- refund --caller <PAYER>

# Reads
stellar contract invoke --network testnet \
  --id "$STELLAR_ESCROW_CONTRACT_ID" -- get_agreement
stellar contract invoke --network testnet \
  --id "$STELLAR_ESCROW_CONTRACT_ID" -- get_milestone --milestone-index 0
stellar contract invoke --network testnet \
  --id "$STELLAR_ESCROW_CONTRACT_ID" -- get_balance
```

**Deployment was not performed here:** no funded testnet source account is
configured in this environment, so no contract ID or transaction hash exists
yet. The commands above are the exact steps to perform it.
