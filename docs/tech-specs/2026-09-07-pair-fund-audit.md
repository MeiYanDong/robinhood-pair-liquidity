# PAIR LP full-history fund audit

## Goal

Reconstruct the audited wallet's complete PAIR LP history without signing or broadcasting transactions. The report separates:

1. external capital entering and leaving the wallet boundary;
2. user-confirmed backup-capital PAIR purchases;
3. LP-fee-funded PAIR purchases;
4. principal recycled through swaps and migrations whose source cannot be uniquely attributed;
5. claimed, compounded, terminal, and currently unclaimed LP fees;
6. fee-excluded inventory conversion performed by each LP NFT lifecycle;
7. gas paid by every wallet-originated transaction.

The audit reports token-native quantities first and transaction-time USDG marks second. A market-value mark is not a tax cost basis.

## Source hierarchy

1. Canonical transaction receipts, logs, ownership, liquidity, balances, and exact atomic conservation.
2. The locally rebuilt NFT lifecycle manifest, accepted only when its chain inventory is complete at its recorded safe block.
3. Operation records that contain receipt-backed wallet deltas, fee-growth snapshots, and liquidity-underlying amounts.
4. User assertions for provenance only. They never override chain-observed quantities or execution prices.
5. Nearest-prior canonical pool swaps and CoinGecko ETH history for derived USDG marks.

Unknown provenance stays unresolved. Claimed fees are not added to current assets again because they may already have been reinvested, converted, withdrawn, or retained in the wallet.

## Safe-block and drift policy

`npm run funds:audit` obtains a fresh confirmed safe block and freezes balances, current LP principal, and unclaimed fees before downloading historical explorer data. This ordering avoids the Robinhood public RPC's short historical-state retention window.

The lifecycle manifest may have an earlier safe block. If a successful wallet-originated PositionManager transaction exists between that manifest block and the audit block, the audit fails and requires `npm run portfolio:build` first. It never silently combines a stale lifecycle ledger with fresh balances.

## Fee completeness rules

Fee token quantities are complete within the audited wallet and NFT set only when all three paths close:

- zero-liquidity `ModifyLiquidity` claims are decoded from every wallet PositionManager receipt;
- every empty NFT has principal and terminal fees separated at exit;
- every increase is reconciled against its total underlying liquidity increase and exact wallet token outflow.

An implicit increase fee is added only if one transaction has exactly one positive `ModifyLiquidity`, no negative liquidity operation, and a supported total-underlying evidence source. The difference is:

```text
implicit fee credit = total underlying added - wallet token spend
```

Unsupported or mixed transactions remain partial instead of being estimated. Pure arithmetic and boundary-classification rules are covered by `test/fund-accounting.test.mjs`.

## Conservation invariants

For every tracked ERC-20, exact atomic values must satisfy:

```text
external in + contract in - external out - contract out = safe-block wallet balance
```

Native ETH must satisfy:

```text
external in - contract value - external out - gas = safe-block wallet balance
```

Any nonzero atomic residual is a hard reconciliation mismatch. Router and PoolManager settlement logs never count as external capital merely because an explorer labels a counterparty incompletely.

## Outputs

- `reports/accounting/pair-fund-audit-latest.md`: readable audit report.
- `reports/accounting/pair-fund-audit-latest.json`: canonical machine-readable result.
- `reports/accounting/external-capital.csv`: wallet-boundary capital and distributions.
- `reports/accounting/pair-acquisitions.csv`: PAIR purchase provenance and execution detail.
- `reports/accounting/fee-claims.csv`: deduplicated fee events.
- `reports/accounting/positive-increase-fee-reconciliation.csv`: every historical increase and its implicit-fee check.
- `reports/accounting/lp-inventory-conversions.csv`: fee-excluded per-NFT inventory conversion.
- `reports/accounting/exceptions.csv`: unresolved facts that can change PnL or attribution.

## Acceptance criteria

1. NFT inventory passes `npm run portfolio:verify`.
2. No supply event is missing for a positive liquidity operation.
3. Every empty NFT has a principal/terminal-fee split or is explicitly reported as unresolved.
4. Every existing-position increase is recorded, derived under the strict rule above, or explicitly unresolved.
5. ETH and all tracked ERC-20 balances conserve exactly at atomic precision.
6. User-funded, fee-funded, and unresolved/recycled PAIR acquisitions remain separate.
7. The report never presents a counterfactual replacement value or asynchronous market-value bridge as actual portfolio PnL.
8. The workflow reads public chain data only and never loads a private key, signs, or broadcasts.

## Remaining personal-level boundaries

The wallet audit cannot infer the original fiat cost of PAIR transferred in from another address. Assets transferred out are distributions at this wallet boundary; if the receiving address is still user-owned, personal-level PnL requires expanding the audit scope to that address. Mixed SPY produced by LP sales, external ETH purchases, fee claims, and withdrawals cannot be uniquely assigned to a source after commingling unless a user-confirmed batch or exact same-transaction lineage exists.
