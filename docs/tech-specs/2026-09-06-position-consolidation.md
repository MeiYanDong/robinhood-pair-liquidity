# Position consolidation: #2006287 into #2008008

## Goal

Retire PAIR/SPY NFT `2006287` and add only its returned assets to existing NFT `2008008`, without a swap, a new NFT, or use of pre-existing wallet SPY/PAIR.

## Acceptance criteria

1. Source liquidity is zero and ownership remains with the wallet.
2. Target ticks remain `[94600, 97400)` and target liquidity increases.
3. Wallet SPY spend is zero; wallet PAIR never falls below its pre-operation protected floor.
4. Every non-target LP retains its observed liquidity.
5. No pending nonce remains; both receipts are successful.
6. Final ETH is at least `0.005`; aggregate gas is at most `5 USDG` at the execution marks.
7. The portfolio ledger is rebuilt and reports complete chain inventory.

## Small stories

- As an operator, I can cap an increase by exact PAIR atomic units so unrelated wallet inventory is protected.
- As an operator, I can stop when the target is no longer PAIR-only, preventing an implicit SPY spend.
- As an auditor, I can trace source removal, target increase, fees, gas, and final balances to canonical transaction hashes.
- As a dashboard reader, I can distinguish LIVE, REFRESHING, STALE, and process liveness without stale data being reported as healthy.

## Verification evidence

Runtime receipts and post-state are written under the private `runs/` directory. The public ledger contains addresses, NFT IDs, token amounts, transaction hashes, evidence quality, and no private key material.
