# Changelog

## 2026-09-06

- Consolidated PAIR/SPY NFT `2006287` into existing NFT `2008008` with an exact wallet PAIR cap.
- Added protected-balance and PAIR-only execution guards with tests.
- Reconciled externally created NFT `1983646` and three previously unrecorded wallet transactions.
- Made dashboard readiness fail on stale data, preserved the REFRESHING state, and renamed modeled fee annualization.
- Serialized outbound dashboard RPC starts at a configurable minimum interval after the production public endpoint returned HTTP 429 on the twelfth burst request.
- Added lint, formatting, scoped JavaScript type checks, tests, CI, an ADR, and an operation tech spec.
