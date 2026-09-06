import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ledgerPath = path.join(root, 'dashboard', 'config', 'lp-portfolio-ledger.json')
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))

assert.equal(ledger.audit?.inventoryStatus, 'verified_complete_at_safe_block')
assert.deepEqual(ledger.audit?.localIds, ledger.audit?.chainIds)
assert.equal(ledger.audit?.missingLocally?.length, 0)
assert.equal(ledger.audit?.missingOnChain?.length, 0)
assert.ok(Array.isArray(ledger.positions) && ledger.positions.length > 0)
assert.ok(Array.isArray(ledger.transactions) && ledger.transactions.length > 0)

const serialized = JSON.stringify(ledger)
for (const forbidden of ['privateKey', 'seedPhrase', 'mnemonic']) {
  assert.equal(serialized.includes(forbidden), false, `public ledger contains forbidden field ${forbidden}`)
}

const active = ledger.positions.filter((position) => BigInt(position.lastKnownLiquidity || 0) > 0n)
console.log(
  JSON.stringify({
    status: 'PUBLIC_LEDGER_VERIFIED',
    safeBlock: ledger.audit.safeBlock,
    lifecycleNfts: ledger.positions.length,
    activeNfts: active.length,
    receipts: ledger.transactions.length,
  }),
)
