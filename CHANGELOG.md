# Changelog

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
- Added lint, formatting, scoped JavaScript type checks, tests, CI, an ADR, and an operation tech spec.
