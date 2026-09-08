# ADR 0004: External strategy accounts use isolated, chain-only read models

- Status: Accepted
- Date: 2026-09-08

## Context

The public dashboard originally followed one historical PAIR/SPY wallet and combined its audited local ledger with live
PositionManager reads. A second dedicated wallet now runs a finite-martingale PAIR/USDG strategy. Its NFT set changes when
the private keeper rotates a band, so a static token ID list would bring back the manual dashboard-update failure mode.

The new wallet does not share the original wallet's cost ledger. The public host must not receive a signing key, signed
intent, webhook credential, private RPC URL, or access to the keeper's run directory merely to display public chain state.

## Decision

Each configured external strategy account gets its own SQLite inventory database and identity composed from chain, strategy
ID, wallet, pool, and scan origin. The dashboard:

1. scans incoming and outgoing PositionManager `Transfer` events from a configured public block;
2. verifies `balanceOf`, `ownerOf`, liquidity, pool key, and ticks at the same safe block;
3. reads principal and uncollected fee growth only for currently owned positions in the declared pool;
4. publishes the result in snapshot schema v5 and `GET /api/strategies`;
5. marks cost basis and private keeper health as unavailable instead of inferring them;
6. reports strategy degradation independently and does not make the original wallet's readiness depend on a momentary
   external-strategy band rotation.

Strategy IDs are validated before being used in database filenames. Wallet addresses, pool IDs, scan origins, and expected
band counts are public configuration; credentials and transaction state are prohibited.

## Consequences

- A new, transferred, burned, or replacement NFT appears without a code or JSON token-list edit after it reaches the safe
  block.
- The original wallet and external strategy cannot contaminate one another's cursor or accounting tables.
- A complete chain view can be `VERIFIED` while total profit, cost basis, and keeper liveness remain `UNKNOWN`; the API and UI
  show those evidence boundaries explicitly.
- The production backup set must include every `strategy-inventory-*.sqlite` database and WAL/SHM files in addition to the
  original dashboard database.
- Connecting private keeper telemetry later requires a separately authenticated, sanitized health channel and a new ADR; it
  is not implied by this decision.
