# ADR 0001: Staged, receipt-led chain execution

- Status: accepted
- Date: 2026-09-06

## Context

PAIR liquidity operations move real assets on Robinhood Chain. RPC timeouts, price movement, a pending nonce, or an incomplete local ledger can turn a blind retry into a duplicate or unintended transaction.

## Decision

Every write follows four stages: live chain reconciliation, read-only preflight, one bounded broadcast, and receipt plus post-state verification. A transaction hash is persisted before waiting for confirmation. Unknown or reverted receipts stop the workflow; recovery resumes only the unconfirmed stage. Wallet token budgets, protected LP liquidities, minimum ETH reserve, and gas ceilings are explicit invariants.

Generated dashboard data is not proof of execution. Only canonical receipts and same-chain post-state reads close an operation.

## Consequences

Execution is slower and code carries recovery state, but ambiguous retries and accidental wallet-wide spending are fail-closed. Historical price marks may remain derived or partial when the public RPC cannot serve an archival read.
