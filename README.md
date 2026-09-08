# Robinhood Chain PAIR liquidity operations

Audited operator tooling, a public lifecycle ledger, and a live read-only dashboard for concentrated
PAIR liquidity on Robinhood Chain.

- Live dashboard: <http://47.251.187.250/>
- Chain: Robinhood Chain (`4663`)
- Tracked wallet: `0xe864237f450E3C813EB6C5652106EC3AFd9Bc919`
- License: MIT

The repository intentionally separates three evidence levels:

1. **Canonical execution:** successful transaction receipts plus post-state reads.
2. **Audited public ledger:** transaction hashes, amounts, NFT lineage, gas, and evidence quality.
3. **Dashboard analytics:** current balances, range state, captured fees, and window-annualized gross
   fee rates. Analytics are not transaction receipts and the displayed annualization is not a promised
   APR.

## Safety model

The transaction scripts move real assets. A write is allowed only after inventory reconciliation and a
fresh read-only preflight. Each operation has explicit token budgets, protected wallet floors, protected
non-target LP liquidity, a minimum ETH reserve, and a gas ceiling. A transaction hash is persisted before
receipt waiting, and recovery resumes only an unconfirmed stage.

Signing keys are never accepted from a repository file or environment variable. Operator scripts read a
named item from the local macOS Keychain and verify that the derived address matches the configured wallet.
`runs/`, `.env` files, wallet exports, RPC credentials, and server credentials are excluded from Git.
Set `PAIR_KEYCHAIN_SERVICE` to the name of an existing generic-password item when the default
`robinhood-pair-liquidity` service name is not used. Never pass the secret itself as an environment value or
command-line argument.

Read [ADR 0001](docs/adr/0001-staged-chain-execution.md) before using an executor. The completed
`#2006287 -> #2008008` operation and its acceptance criteria are documented in the
[position-consolidation tech spec](docs/tech-specs/2026-09-06-position-consolidation.md).

## Local quality gate

Node.js 22 or newer is required because the ledger builder uses `node:sqlite`.

```shell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`npm run check` enforces repository formatting, ESLint, strict JavaScript type checking for the
safety-critical guard and read-model modules, the full business test suite, and public-ledger completeness assertions. GitHub
Actions runs the same gate for every push and pull request, plus a dashboard process/static-UI smoke test.
The production dashboard dependency tree is separately blocked on high-severity audit findings with
`npm run security:audit:dashboard`.

Useful read-only commands:

```shell
npm run portfolio:verify
npm run funds:audit
npm run lp:status
npm run liquidity-map
npm run trend:scenarios
npm run dashboard
```

The lifecycle manifest is committed at
[`dashboard/config/lp-portfolio-ledger.json`](dashboard/config/lp-portfolio-ledger.json). Rebuilding it
requires the private, ignored `runs/` evidence directory and live RPC access; public CI verifies the
committed manifest but does not fabricate missing private history.

## Executing an LP change

Every mutation is split into `preflight`, `enter`, `resume`, and `status` commands. Never jump directly to
`enter`, and never blind-retry after a timeout. For the two operations used in the latest consolidation:

```shell
npm run retirement:preflight
npm run retirement:enter
npm run increase:preflight
npm run increase:enter
```

Required operation-specific limits are passed as environment variables. See the relevant script and tech
spec for the exact variables. The repository ships no signing key and no production RPC credential.

The latest official Uniswap V4 SDK still pulls known vulnerable legacy/build-tool transitive packages.
They are absent from the dashboard release, but remain an acknowledged operator-tool dependency until an
upstream-compatible replacement exists. See [ADR 0002](docs/adr/0002-uniswap-sdk-dependency-risk.md); do
not interpret a clean dashboard audit as a clean audit of the executor SDK tree.

## Dashboard operations

The Node service serves the UI and JSON endpoints; Nginx is the public reverse proxy.

- `/livez` proves only that the process is alive.
- `/readyz` returns success only when usable data is current.
- `/healthz` carries the detailed refresh state and returns failure for stale/unready data.
- `/api/inventory` exposes the PositionManager Transfer index and same-safe-block ownership reconciliation.
- `/api/strategies` exposes isolated, chain-only inventories for configured external LP strategy wallets without importing
  their signer state or cost ledger.
- `/api/trend` exposes the versioned, read-only `$0.01`-centred range model.
- `/api/portfolio` exposes the public lifecycle ledger and same-safe-block position readback.

The server discovers newly received/minted and withdrawn PositionManager NFTs automatically. It does
not invent a cost basis for an unclassified NFT: accounting remains `UNKNOWN_EXTERNAL_ORIGIN` until an
audited ledger event attributes the capital.

The dedicated PAIR/USDG finite-martingale account is intentionally separated from the historical PAIR/SPY
portfolio. Its public view auto-discovers replacement bands from chain events and values current principal
and fees at one safe block; private keeper liveness and cost basis remain separate evidence domains. See
[ADR 0004](docs/adr/0004-external-strategy-accounts.md).

Production deployment is deliberately manual and credential-free from GitHub. Follow the
[deployment runbook](docs/runbooks/deploy-dashboard.md). Passing CI proves repository quality; only the
documented public runtime readback proves deployment.

## Secret scan before a public commit

Inspect the exact Git index, not only the working tree:

```shell
git ls-files
git grep -n -E '(BEGIN [A-Z ]*PRIVATE KEY|mnemonic|seed phrase|PRIVATE_KEY=|RPC_URL=https?://[^ ]+@)'
git grep -n -E '(^|/)(runs|node_modules|\.env)(/|$)'
```

Transaction hashes are public 32-byte values and therefore should not be treated as private-key matches.
