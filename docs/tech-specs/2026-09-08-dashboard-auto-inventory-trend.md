# Automatic LP inventory and trend dashboard v3

- Status: locally implemented; production verification pending
- Date: 2026-09-08
- Economic execution status: not authorized

## Objective

Make the public dashboard discover PositionManager NFT changes without a Codex-edited position list, and visualize a price-domain PAIR trend-range model. The service remains public, read-only, and incapable of signing or broadcasting.

## Inventory data path

The runtime uses `dashboard/lib/position-inventory.mjs` and the existing dashboard SQLite database:

1. A previously audited `verified_complete_at_safe_block` manifest may seed known NFTs only after its recorded block hash matches the canonical chain.
2. The service scans PositionManager `Transfer` logs in both wallet directions from a persistent cursor.
3. Events and cursor advancement share one SQLite transaction and `(transaction_hash, log_index)` is unique.
4. The cursor block hash is re-read before continuation. A mismatch resets the inventory path to the configured full-scan origin.
5. Every safe snapshot rereads `ownerOf`, `getPositionLiquidity`, and `getPoolAndPositionInfo` for every inferred owned NFT. This catches increases and decreases, which do not emit ERC-721 transfers.
6. PositionManager `balanceOf(wallet)` must equal the inferred owned NFT count. A seeded mismatch triggers one full wallet-transfer rescan; a remaining mismatch stays `PARTIAL` and prevents readiness.
7. Runtime PAIR/SPY and PAIR/USDG position lists are generated from verified current liquidity. Empty NFTs stay in lifecycle history.
8. A new NFT with no local provenance appears as `external-unclassified`; token cost, cash basis, and funding source remain `UNKNOWN` until a separate audited ledger event closes them.

The public contract is `GET /api/inventory`. It reports safe/cursor blocks, hashes, expected and indexed counts, lifecycle counts, warnings, and evidence method.

## Trend range model

`dashboard/lib/trend-model.mjs` builds candidates in PAIR/USDG price space and then aligns the bounds outward to pool Tick spacing. The center preference is `0.010 USDG`, with default raw candidates around `0.008`, `0.010`, `0.012`, and `0.015`. The center is a preference, not a hard lower bound.

Placements are generated both from current-price upside skews and directly from the 1h/6h volume P10/P90 boundaries. Duplicate Tick ranges retain every anchor source. For each placement, the model records:

- requested and decoded low/high prices;
- actual absolute width and deviation from `0.010`;
- 1h and 6h path-allocated volume coverage;
- current per-bin market liquidity;
- modeled post-add market share and comparative fee capture;
- current-price position inside the candidate.
- qualification checks, rejection reasons, and whether the decoded width sits outside the preferred band.

The selected `activeTarget` must pass evidence gates before it is marked qualified. `nextTarget` overlaps the active target by design and is always `PREPARE_ONLY` in this read-only release. Neither object is an exact mint quote or expected-profit promise.

The public contract is `GET /api/trend`. Every result includes a model version, fixed `executionAuthorized=false`, snapshot identity, safe block, evidence level, flow thresholds, all candidates, active target, next target, and limitations.

## Frontend behavior

The trend radar overlays the current price, 6h volume heat, current active LP ranges, the selected target, and the next prepared band on one PAIR/USDG axis. Text cards expose range bounds, width deviation, hot band, volume acceleration, PAIR buy share, and leading alternatives. “Shadow 建议，不会自动交易” is shown independently of color.

The browser continues to poll every five seconds while visible, but skips DOM/chart reconstruction when `snapshotId + window` has not changed. A hidden tab polls every 30 seconds and refreshes immediately when visible again.

## Evidence and failure semantics

- `VERIFIED`: canonical same-safe-block inventory count and all owned NFT reads match.
- `MODELLED`: deterministic calculation from a verified snapshot; not realized revenue or execution proof.
- `PARTIAL`: count mismatch, read failure, incomplete market window, or no qualified range.
- `UNKNOWN`: missing cost attribution or unavailable source.

The service readiness contract requires a successful current-process market snapshot and `inventory.status=VERIFIED`. A stale previously saved snapshot, a green HTTP response, or a local unit test cannot substitute for production readback.

## Acceptance commands

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run trend:scenarios
npm run portfolio:verify
npm run deploy:check
```

Production acceptance additionally requires `/livez`, `/readyz`, `/healthz`, `/api/inventory`, `/api/trend`, and browser readback on the deployed Git commit for at least two refresh cycles.
