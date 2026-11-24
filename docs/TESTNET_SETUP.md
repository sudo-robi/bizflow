# Stellar Testnet Setup

BizFlow operates **exclusively on Stellar Testnet**. It will refuse to start if
mainnet Horizon or the mainnet network passphrase is configured.

## Network settings

| Setting | Value |
|---|---|
| Network | Testnet |
| Network passphrase | `Test SDF Network ; September 2015` |
| Horizon | `https://horizon-testnet.stellar.org` |
| Soroban RPC | `https://soroban-testnet.stellar.org` |
| Explorer | `https://explorer.stellar.org/?chain=testnet` |
| Initial asset | Native XLM (`asset_code=XLM`, `asset_issuer=null`) |

These are configured in `.env` (see `.env.example`) and must never be scattered
through application code.

## Creating a funded Testnet account

1. Generate a keypair with the official CLI or an SDK:

   ```bash
   stellar keys generate bizflow-test --network testnet
   stellar keys address bizflow-test
   ```

   Or with the Python SDK:

   ```bash
   python -c "from stellar_sdk import Keypair; k=Keypair.random(); print(k.public_key); print(k.secret)"
   ```

2. Fund it with Friendbot (Testnet only):

   ```bash
   curl "https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>"
   ```

3. Place the secret in a **local, git-ignored** `.env` or in your OS secure store.
   Never commit it, never send it to the browser, never expose it to the frontend.
   The application only ever receives public keys from Freighter.

## Verifying a real transaction

```bash
export TESTNET_SECRET=S...   # local only
python docs/scripts/testnet_smoke.py
```

The script builds a real payment, signs it, submits it, then independently re-fetches
it from Horizon and checks source, destination, asset, amount and memo. It prints
the real hash and explorer link. It does not fabricate any result. A successful run
during development produced:

- Verified payment hash: `68ee9d8b2ac98f53c2a030a49043948cafb8d2a58cb7a73f391c6a77da83cbbc`
- Explorer: <https://explorer.stellar.org/tx/68ee9d8b2ac98f53c2a030a49043948cafb8d2a58cb7a73f391c6a77da83cbbc?chain=testnet>

## Wallet (Freighter)

1. Install the Freighter browser extension.
2. Create/import a Testnet account and fund it via Friendbot.
3. In Freighter, switch the network to Testnet.
4. In BizFlow, open **Wallet** and connect. The app checks the selected network and
   refuses to sign on mainnet.
5. Every signature request shows the full transaction details (amount, asset,
   destination, memo, network and fee) before you approve. Rejecting a request is
   handled gracefully and leaves no pending payment marked as paid.

BizFlow never asks for, receives, or stores a private key, seed phrase or recovery phrase.

## Soroban escrow

The escrow contract must be compiled to WASM and deployed to Testnet before the
milestone-release flow can run on-chain. See `SMART_CONTRACTS.md`. The real deployed
contract ID is placed in `STELLAR_ESCROW_CONTRACT_ID`; until then the application
reports the escrow integration as unavailable rather than simulating it.
