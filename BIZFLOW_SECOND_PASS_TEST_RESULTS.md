# BizFlow — Second-Pass Test Results

Full evidence: `BIZFLOW_FINAL_TEST_RESULTS.md`.

| Suite | Command | Result |
|---|---|---|
| Backend | `USE_SQLITE=true .venv/bin/python -m pytest -o addopts='' -q --disable-warnings` | 244 passed, 1 warning |
| Backend coverage | `pytest --cov=app --cov-report=term-missing` | 95% (3208 statements, 174 missed) |
| Frontend | `npx vitest run` | 260 passed in 19 files; coverage 86.68% lines |
| Frontend typecheck/build | `npm run typecheck`, `npm run build` | PASS; 20/20 static pages |
| Contract | `cargo test` | 47 passed |
| Contract coverage | `cargo llvm-cov report` | 98.28% lines |
| Migrations | fresh `alembic upgrade head` | head `0005_feature_completeness` |
| Browser E2E | Playwright MCP register → dashboard | PASS |
| Testnet readback | Soroban `get_balance` simulation | `{"funded":20000000,"released":10000000,"remaining":10000000}` at ledger 5907394 |

Blocked: Docker image build (daemon DNS), GHCR packages (workflow scope), funded-wallet live payment E2E (no `TESTNET_SECRET`).
