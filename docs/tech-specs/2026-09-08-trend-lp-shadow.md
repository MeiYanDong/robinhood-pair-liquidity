# Trend LP Shadow: read-only policy, scenario replay, and calldata feasibility

- Status: implemented for shadow observation
- Date: 2026-09-08
- Economic execution status: not authorized

## Objective

Turn the proposed PAIR upward-range management rules into a deterministic, auditable, read-only system before considering a 7×24 keeper. The system must distinguish policy simulation, historical counterfactuals, current chain evidence, calldata simulation, and actual receipts.

## Non-goals

- No wallet credential access, signing, approval, transaction submission, contract deployment, cron job, or daemon.
- No automatic PAIR purchase.
- No claim that a passing scenario is profitable or globally optimal.
- No reconstruction of actual historical LP PnL from a market-swap database alone.

## Decision model

The policy evaluates one normalized observation and produces one mutually exclusive action:

- observe: hold, prepare an unsigned plan, wait for confirmation, hold because a higher band already covers the move, or respect cooldown;
- normal: roll only after a confirmed breakout and a qualified volume/liquidity target;
- urgent: on a strong breakout or two skipped bands, use one bounded tranche instead of repeatedly chasing obsolete intermediate ranges;
- risk: exit a confirmed reversal, or withdraw first and requote when immediate price impact is too high;
- reconcile/degraded: stop new-risk decisions for a pending nonce, uncertain receipt, incomplete inventory, stale snapshot, or inconsistent price read.

All roll recommendations are capped at 2,500 basis points of eligible capital. Gas is only an anomaly fuse at `25 USDG`: there is no eight-hour fee-payback test and the policy never waits merely to reduce an ordinary `1 USDG` transaction to `0.5 USDG`. This is a policy ceiling, not authority to spend.

## Evidence pipeline

### Deterministic scenarios

`npm run trend:scenarios` evaluates 38 fixtures. They include small wicks, insufficient confirmation, weak volume, weak net buying, existing higher coverage, non-blocking ordinary gas variation, the absolute gas-anomaly boundary, multi-band gaps, cooldown, stale/inconsistent data, pending state, risk exits, and high-impact staged exits.

Acceptance criteria:

- at least 20 fixtures;
- actual action equals the reviewed expected action for every fixture;
- all outputs keep execution disabled and additional PAIR buying false;
- invalid negative money inputs and capital above 100% fail validation.

Passing means policy conformance under fixture assumptions. It does not establish an optimum against unknown future prices, liquidity, MEV, hook behavior, or realized fees.

### Historical coverage replay

`npm run trend:history` applies the current nonzero PAIR/SPY ladder to locally retained historical swaps and reports swap-count coverage, SPY-marked input-volume coverage, transitions, and uncovered tick segments.

This output is classified as `counterfactual_current_ladder`. The database does not contain a block-by-block record of the wallet's then-current NFT inventory or event active liquidity, so this command does not report actual historical market share, fees, gas, impermanent loss, or PnL.

### Live single observation

`npm run trend:live-once` fixes a head block and reads:

- PAIR/SPY slot0 and active liquidity;
- SPY/USDG mark;
- the wallet's PositionManager NFT balance;
- owner and liquidity for every NFT in the audited ledger;
- latest and pending nonces;
- PositionManager and Universal Router deployed bytecode;
- the public dashboard snapshot for freshness, tick agreement, and inventory drift.

It reads the 1h and 6h dashboard windows independently. Directional SPY/PAIR input is valued at the current marks to estimate PAIR buy share, and one-hour volume is compared with one sixth of six-hour volume. The target-range search now generates upward-skewed candidates in PAIR/USDG price space around the configurable `0.010 USDG` center preference, then aligns them outward to pool Tick spacing. The default raw widths are approximately `0.008/0.010/0.012/0.015`; `0.010` is not a hard minimum. Candidates use:

- 1h and 6h volume coverage;
- market liquidity in each overlapped bin;
- modeled market share and fee capture for a reference tranche equal to 25% of current active wallet liquidity;
- capital-efficiency dilution and decoded-width deviation;
- a controlled-overlap next band that remains `PREPARE_ONLY`.

The range result is a comparative model, not an exact mint quote or promised fee return.

It then builds exact unsigned full-removal calldata for every owned nonzero PAIR/SPY NFT and invokes `eth_call` from the wallet address. The report stores calldata, hash, byte length, call result, and an estimate when available.

`npm run trend:series -- --samples=3 --interval-ms=15000` repeats this read-only observation a bounded number of times and records whether samples reached distinct chain blocks and dashboard generations. Repeated reads of the same cached dashboard generation do not count as independent market confirmation.

Trusted samples also advance `runs/pair-trend-shadow-state.json`. Because PAIR price rises as the PAIR/SPY tick falls, the sequence engine treats movement from at-or-above an NFT's `tickLower` to below it as an upward exit. It persists the first crossed boundary, distinct-block confirmation count, seconds above the boundary, crossed band count, active-liquidity loss, and whether another live NFT still covers the new price. An untrusted or non-increasing-block sample cannot advance confirmation; a return through the boundary clears the candidate as a filtered wick.

Acceptance criteria:

- direct NFT count equals the wallet's on-chain PositionManager balance;
- every owner/liquidity read succeeds before inventory is called complete;
- dashboard disagreement is visible rather than silently trusted;
- pending nonce or local receipt uncertainty selects reconciliation instead of a new plan;
- every written decision remains advisory.

## Outputs

- `reports/trend-lp-shadow-scenarios-latest.json`: deterministic fixture evidence.
- `reports/trend-lp-shadow-history-latest.json`: counterfactual coverage evidence.
- `reports/trend-lp-shadow-live-latest.json`: current same-block evidence and unsigned probes.
- `reports/trend-lp-shadow-series-latest.json`: bounded consecutive observation evidence.
- `runs/pair-trend-shadow-decisions.jsonl`: local append-only advisory decisions; excluded from the public repository with other `runs/` data.
- `runs/pair-trend-shadow-state.json`: restart-safe market sequence state; it contains no credential or transaction authority.

## Remaining gate before an executable keeper

The current probe validates full withdrawal only. The exact atomic or staged path for withdrawal, depth-aware swap, and range mint has not been constructed or simulated end to end. Sequence restart recovery is implemented locally, but reversal detection, exact balance-aware mint sizing, price impact, cooldown persistence, long-running service supervision, and alert delivery still need live shadow evidence. Until those gates close, `HOLD`, `PREPARE`, `ROLL`, or `EXIT` are recommendations only.
