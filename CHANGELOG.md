# Changelog

## 2026-09-08

- Added a persistent PositionManager NFT inventory indexer with canonical `Transfer` cursors, block-hash reorg checks, same-safe-block `balanceOf/ownerOf/liquidity/pool-info` reconciliation, and fail-closed mismatch recovery.
- Made current PAIR/SPY and PAIR/USDG position sets derive from the runtime inventory instead of a constructor-time static manifest; newly discovered positions remain `UNKNOWN` for cost attribution until audited.
- Replaced fixed Tick-width trend candidates with a price-domain v3 model centered around an approximately `0.010 USDG` configurable width, including `0.008/0.010/0.012/0.015` candidates, direct 1h/6h hot-zone anchors, Tick round-trip output, qualification reasons, liquidity competition, projected share, and a non-executable next band.
- Added versioned `/api/inventory` and `/api/trend` read models, snapshot identities, subsystem health, and a dashboard trend radar that overlays volume heat, live LP ranges, current price, active target, and next target.
- Made the browser skip unchanged snapshots and slow polling while hidden; all dashboard inventory and trend paths remain read-only and contain no account/signing/broadcast primitive.
- Added a fail-closed, read-only Trend LP Shadow policy with 38 deterministic breakout, gas, reversal, and degraded-data scenarios.
- Added counterfactual current-ladder history coverage replay and same-block live NFT reconciliation.
- Added exact unsigned full-removal calldata probes through `eth_call`; atomic withdraw/swap/remint remains explicitly unproven.
- Replaced the eight-hour fee-payback and cheap-gas wait gates with a `25 USDG` gas-anomaly fuse, so ordinary gas differences do not delay a qualified recommendation.
- Added 1h/6h flow signals, volume/liquidity/share-based upward-range selection, and bounded live-series evidence.
- Added restart-safe cross-block breakout state for boundary crossings, wick clearing, skipped bands, and remaining active coverage.
- Kept every shadow decision non-executable and prohibited additional PAIR buying.

## 2026-09-07

- Added a receipt-backed full-history PAIR LP fund audit with strict external-capital, fee-funded, and recycled-principal separation.
- Reconciled all 23 NFT lifecycles, including the previously missing `$1/USDG` exit, all 18 terminal exits, and all 15 existing-position increases.
- Added exact atomic ETH/ERC-20 conservation, fee-claim deduplication, LP inventory-conversion reporting, CSV evidence exports, and pure accounting tests.
- Made the audit freeze a fresh safe-block state before slower explorer history reads and fail on lifecycle-ledger drift.
- Rebuilt the public lifecycle manifest at safe block `56528875`, reconciling all `22/22` wallet NFTs with no missing local or on-chain IDs.
- Added externally completed NFT `2073305` and the five receipt-backed collect, rebalance, and compound transactions that increased NFT `1936443` liquidity from `317696387997582734044` to `458159458353467559856`.
- Advanced the earlier public ledger to `136` canonical transaction receipts and `54` recorded fee claims before the later 24-NFT audit superseded that snapshot.

## 2026-09-06

- Consolidated PAIR/SPY NFT `2006287` into existing NFT `2008008` with an exact wallet PAIR cap.
- Added protected-balance and PAIR-only execution guards with tests.
- Reconciled externally created NFT `1983646` and three previously unrecorded wallet transactions.
- Made dashboard readiness fail on stale data, preserved the REFRESHING state, and renamed modeled fee annualization.
- Batch concurrent JSON-RPC methods and throttle only real HTTP request starts after the production public endpoint returned HTTP 429 on the twelfth burst request.
- Reduced public-RPC pressure further by filling configured JSON-RPC batches, moving the dashboard to a 30-second cadence, and removing immediate full-snapshot retries.
- Aligned the systemd runtime contract with that cadence and made exact Git provenance mandatory for every installed release.
- Lowered the public-RPC cadence to one minute after a 30-second production soak still throttled, and distinguish fresh-but-degraded snapshots from genuinely stale data.
- Require every restarted dashboard process to publish one successful current-process snapshot before readiness can pass.
- Give deployment readiness two full one-minute refresh opportunities before the installer reports failure.
- Aggregate concurrent contract reads through the verified Robinhood Chain Multicall3 deployment before they reach the rate-limited public RPC.
- Added lint, formatting, scoped JavaScript type checks, tests, CI, an ADR, and an operation tech spec.
