# Live Testnet Deployment Record

All values below are **real** artifacts produced during this build. They are Testnet-only.
No contract ID, hash or address was invented.

## Soroban escrow contract

| Item | Value |
|---|---|
| Contract source | `contracts/escrow/` |
| WASM artifact | `target/wasm32v1-none/release/bizflow_escrow.wasm` (11,987 bytes optimized) |
| WASM hash | `65db0f966e0f18ac59272ce6f664b66a62c1780b74b612f1e69f02081743a7cd` |
| **Deployed contract ID** | **`CBEIRUNYWZ54JOSYJD6VGJUTPAZHPMEOJIAYECWCXZVMT7FOBBO57HGK`** |
| Explorer | <https://lab.stellar.org/r/testnet/contract/CBEIRUNYWZ54JOSYJD6VGJUTPAZHPMEOJIAYECWCXZVMT7FOBBO57HGK> |
| Native XLM SAC (real, derived) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

The native XLM Stellar Asset Contract was already present on Testnet; its id was derived
with `stellar contract id asset --asset native --network testnet` (not invented).

### Deployment / initialization transactions

| Action | Real transaction hash |
|---|---|
| Upload WASM | `cc226fdf3b661a6d6c0c516e3f70c061994833cad1ec71bca49333f6e638beb4` |
| Create contract instance | `04f583d863f786e3d2c6fef84cd071d31ad1f71fc87b8017b25da9e8f4de0e5e` |
| `init` (agreement 1, 2 milestones, 2 XLM) | `215394c1c43b41d2786758fa8e844cddcad6fb99f04d24e0e885daf7392032f6` |
| `fund` (2 XLM into escrow) | `2bf7f11758a93b0751d76905c15b654b42c40dae645e144a9ac0c362c5373f9a` |
| `approve_milestone` (index 0) | `b1600d6128a013034172292a7cbc57622a9f5dee87c68aea7fe207527232e763` |
| `release_milestone` (index 0, 1 XLM to payee) | `187db0721a9cacd164dc9ff4f16ac4b88f105c1e64ca9b047a30c8c9e1b60966` |

Observed on-chain events included `init`, `funded`, `approved`, `released` and SAC
`transfer` events. Final `get_balance` readback:

```json
{"funded":"20000000","released":"10000000","remaining":"10000000"}
```

Negative checks on the live contract (simulation only, no state change):
- duplicate `release_milestone(0)` → `Error(Contract, #8)` (`AlreadyReleased`)
- `refund` after a release → `Error(Contract, #6)` (`InvalidState`)

### Ordinary payment smoke test

A real XLM payment with memo was submitted and independently verified against Horizon:
`68ee9d8b2ac98f53c2a030a49043948cafb8d2a58cb7a73f391c6a77da83cbbc`.

## Reproducing deployment

The deployment account is a local, funded Testnet account whose secret is **not in this
repository**. To deploy your own instance:

```bash
# 1. build (Rust 1.84+ target; SDK 30 requires wasm32v1-none)
rustup target add wasm32v1-none
cd contracts/escrow && stellar contract build

# 2. configure a funded Testnet source account
stellar network add testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
stellar keys generate bizflow-test --network testnet
curl "https://friendbot.stellar.org/?addr=$(stellar keys address bizflow-test)"

# 3. deploy and record the REAL id
stellar contract deploy \
  --wasm target/wasm32v1-none/release/bizflow_escrow.wasm \
  --source-account bizflow-test --network testnet --alias bizflow-escrow

# 4. put the printed contract id into .env as STELLAR_ESCROW_CONTRACT_ID
```

Because one contract instance holds exactly one agreement, production use should deploy
one instance per agreement. The single deployed instance above is the live demonstration
agreement; the backend also supports building release invocations for a configured
contract id.
