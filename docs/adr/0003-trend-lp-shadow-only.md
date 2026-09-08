# ADR 0003: Trend LP automation starts as a non-executable shadow system

- Status: accepted
- Date: 2026-09-08
- Implementation plan: [`../plan.md`](../plan.md)

## Context

PAIR can move through concentrated-liquidity ranges faster than a person can react. Waiting for a `0.5 USDG` versus `1 USDG` gas difference, or for an eight-hour fee-payback forecast, can cost more in missed range coverage than it saves. At the same time, an automatic keeper that can read wallet credentials, approve spenders, buy PAIR, and submit transactions would materially expand custody and loss risk before its signals and recovery behavior have been proven.

The current public dashboard also has a known inventory lag: direct same-block chain reads find nonzero NFTs that the configured dashboard position list does not yet show. A dashboard-only keeper could therefore reason from an incomplete portfolio.

## Decision

The first implementation is a read-only Shadow system:

- its policy core is a pure function and every result has `executionAuthorized=false`;
- it cannot buy additional PAIR and recommends at most 25% of eligible capital for one roll;
- it reads current state at one block, reconciles all locally known NFT owners and liquidities, checks latest versus pending nonce, and cross-checks the public dashboard;
- it emits an append-only local decision record only when explicitly invoked with `--write`;
- it may build unsigned calldata and submit it to `eth_call` for feasibility evidence, but it cannot sign or broadcast;
- it derives 1h versus six-hour hourly volume acceleration and mark-valued PAIR buy share, then searches reviewed upward-skewed ranges using 1h/6h volume coverage, per-bin market liquidity, and modeled fee share rather than spot price alone;
- it can collect a bounded series of live observations without installing a daemon;
- incomplete inventory, stale data, cross-source tick divergence, pending nonce, or an uncertain receipt stops new-risk recommendations.

The public dashboard now owns a persistent read-only PositionManager inventory index. It advances an event cursor only after a successful canonical log chunk, rechecks the cursor block hash, rereads every inferred owned NFT at the same safe block, and reconciles the count against `balanceOf`. Runtime position sets are derived from this inventory rather than a constructor-time static list. A mismatch makes readiness fail and can trigger a full historical wallet-transfer rescan; it never creates an executable intent.

Trend ranges are generated in PAIR/USDG price space around a configurable `0.010 USDG` center preference. The default family includes approximately `0.008`, `0.010`, `0.012`, and `0.015` widths before Tick alignment. This is not a minimum-width rule. Volume location, current market-liquidity competition, projected share, and width deviation participate in selection. The dashboard also displays a controlled-overlap next band as `PREPARE_ONLY`.

Gas is not a timing or fee-payback gate. Normal rolls, urgent rolls, catch-up rolls, and confirmed risk exits do not wait for a cheaper ordinary transaction while modeled total gas is at or below `25 USDG`. Above `25 USDG`, the Shadow system treats gas as anomalous and alerts instead of silently proceeding. Price impact, liquidity quality, data integrity, nonce reconciliation, and receipt state remain independent safety gates.

## Consequences

The system can expose bad assumptions and collect decision evidence without custody expansion. Small gas fluctuations no longer delay a qualifying recommendation, but the `25 USDG` value is only an anomaly policy threshold and not proof that a transaction is economical. It cannot protect the portfolio while nobody is present, because no scheduler or transaction path is armed. Successful removal-leg `eth_call` results prove only that exact full-withdraw calldata worked at a recorded block. Atomic withdraw, depth-aware rebalance, and remint remain `UNKNOWN` until one exact candidate path is constructed and simulated end to end.

Any future executable keeper requires a separate decision and ADR covering custody, allowance bounds, capital scope, target-range selection, rollback and replacement rules, monitoring, and receipt-gated recovery. Shadow success alone is not authorization.
