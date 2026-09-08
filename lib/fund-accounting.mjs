/**
 * Pure accounting helpers for the PAIR LP audit.
 *
 * These functions intentionally know nothing about RPC clients, wallets, or
 * signing. They operate on already-observed public-chain facts so their
 * conservation and attribution rules can be tested without network access.
 */

/** @typedef {{eth: number, spy: number, pair: number, usdg: number, one: number}} Amounts */

/** @type {Readonly<Amounts>} */
export const EMPTY_AMOUNTS = Object.freeze({ eth: 0, spy: 0, pair: 0, usdg: 0, one: 0 })

/**
 * @param {...Partial<Amounts>} items
 * @returns {Amounts}
 */
export function sumAmounts(...items) {
  /** @type {Amounts} */
  const total = { ...EMPTY_AMOUNTS }
  for (const item of items) {
    total.eth += Number(item.eth || 0)
    total.spy += Number(item.spy || 0)
    total.pair += Number(item.pair || 0)
    total.usdg += Number(item.usdg || 0)
    total.one += Number(item.one || 0)
  }
  return total
}

/**
 * @param {Partial<Amounts>} amounts
 * @param {Partial<Record<keyof Amounts, number | null>>} prices
 * @returns {{valueUsdg: number, unknownAssets: string[]}}
 */
export function valueAmounts(amounts, prices) {
  let valueUsdg = 0
  /** @type {string[]} */
  const unknownAssets = []
  for (const asset of /** @type {(keyof Amounts)[]} */ (['eth', 'spy', 'pair', 'usdg', 'one'])) {
    const amount = Number(amounts[asset] || 0)
    if (amount === 0) continue
    const price = asset === 'usdg' ? 1 : Number(prices[asset])
    if (!Number.isFinite(price) || price <= 0) {
      unknownAssets.push(asset)
      continue
    }
    valueUsdg += amount * price
  }
  return { valueUsdg, unknownAssets }
}

/**
 * Deduplicate fee records without merging records that merely share a batch
 * transaction. An NFT is the economic source, so transaction hash + NFT is
 * the canonical key when exactly one source NFT is known.
 *
 * @param {Array<Record<string, any>>} records
 * @returns {Array<Record<string, any>>}
 */
export function dedupeFeeClaims(records) {
  /** @type {Map<string, Record<string, any>>} */
  const byKey = new Map()
  for (const record of records) {
    const hash = String(record.transactionHash || '').toLowerCase()
    const sources = Array.isArray(record.sourceTokenIds) ? record.sourceTokenIds.map(String).sort() : []
    const key = hash && sources.length ? `${hash}:${sources.join(',')}` : String(record.id || `${hash}:${byKey.size}`)
    const incumbent = byKey.get(key)
    if (!incumbent || Number(record.evidenceRank || 0) > Number(incumbent.evidenceRank || 0)) {
      byKey.set(key, record)
    }
  }
  return [...byKey.values()].sort(
    (left, right) =>
      Number(left.blockNumber || 0) - Number(right.blockNumber || 0) ||
      String(left.id || '').localeCompare(String(right.id || '')),
  )
}

/**
 * @param {Array<{transactionHash?: string, sourceTokenIds?: Array<string | number>}>} records
 * @param {string} transactionHash
 * @param {string | number} tokenId
 */
export function hasFeeClaim(records, transactionHash, tokenId) {
  const hash = transactionHash.toLowerCase()
  const id = String(tokenId)
  return records.some(
    (record) =>
      String(record.transactionHash || '').toLowerCase() === hash &&
      (record.sourceTokenIds || []).map(String).includes(id),
  )
}

/**
 * A wallet-facing ERC-20 log is an external capital boundary only when the
 * top-level call is the token contract's direct transfer entrypoint. Router,
 * PoolManager and DEX settlement transfers stay inside strategy activity even
 * when an explorer has not classified the log counterparty as a contract.
 *
 * @param {{success?: boolean, to?: string, method?: string} | null | undefined} transaction
 * @param {string} tokenAddress
 */
export function isDirectExternalTokenTransfer(transaction, tokenAddress) {
  return Boolean(
    transaction?.success &&
    String(transaction.to || '').toLowerCase() === String(tokenAddress || '').toLowerCase() &&
    /^transfer(?:from)?$/iu.test(String(transaction.method || '')),
  )
}

/**
 * @param {{
 *   transactionHashes: string[],
 *   transferByTransaction: Map<string, Partial<Amounts>>,
 *   gasEthByTransaction: Map<string, number>,
 *   costUsdgByTransaction: Map<string, number | null>,
 *   assertedNotionalUsdg?: number,
 *   assertedAveragePairUsdg?: number,
 * }} input
 */
export function reconcilePurchaseBatch(input) {
  /** @type {Amounts} */
  let flows = { ...EMPTY_AMOUNTS }
  let gasEth = 0
  let observedCostUsdg = 0
  let unknownCostTransactions = 0
  for (const transactionHash of input.transactionHashes) {
    const hash = transactionHash.toLowerCase()
    flows = sumAmounts(flows, input.transferByTransaction.get(hash) || {})
    gasEth += Number(input.gasEthByTransaction.get(hash) || 0)
    const cost = input.costUsdgByTransaction.get(hash)
    if (cost == null || !Number.isFinite(cost)) unknownCostTransactions += 1
    else observedCostUsdg += cost
  }
  const pairBought = Math.max(0, flows.pair)
  const observedAveragePairUsdg = pairBought > 0 && unknownCostTransactions === 0 ? observedCostUsdg / pairBought : null
  const assertedPairQuantity =
    Number(input.assertedNotionalUsdg) > 0 && Number(input.assertedAveragePairUsdg) > 0
      ? Number(input.assertedNotionalUsdg) / Number(input.assertedAveragePairUsdg)
      : null
  return {
    flows,
    pairBought,
    gasEth,
    observedCostUsdg: unknownCostTransactions === 0 ? observedCostUsdg : null,
    observedAveragePairUsdg,
    unknownCostTransactions,
    assertedPairQuantity,
    pairQuantityDifferencePct:
      assertedPairQuantity && pairBought > 0
        ? ((pairBought - assertedPairQuantity) / assertedPairQuantity) * 100
        : null,
  }
}

/**
 * Derive the inventory conversion performed by one concentrated-liquidity
 * position. Fees must already be excluded from endpointInventory.
 *
 * @param {{
 *   supplied: Partial<Amounts>,
 *   endpointInventory: Partial<Amounts> | null,
 *   quoteAsset: 'spy' | 'usdg',
 *   quoteUsdg: number | null,
 *   complete: boolean,
 * }} input
 */
export function deriveLpInventoryConversion(input) {
  if (!input.complete || !input.endpointInventory) {
    return { side: 'UNKNOWN', quality: 'UNKNOWN', reason: 'incomplete_principal_or_supply_evidence' }
  }
  const pairDelta = Number(input.endpointInventory.pair || 0) - Number(input.supplied.pair || 0)
  const quoteDelta =
    Number(input.endpointInventory[input.quoteAsset] || 0) - Number(input.supplied[input.quoteAsset] || 0)
  const priceInQuote = pairDelta !== 0 && pairDelta * quoteDelta < 0 ? Math.abs(quoteDelta / pairDelta) : null
  const pairUsdg = priceInQuote != null && Number(input.quoteUsdg) > 0 ? priceInQuote * Number(input.quoteUsdg) : null
  if (pairDelta > 0 && quoteDelta < 0) {
    return {
      side: 'BUY',
      pairDelta,
      quoteDelta,
      quoteAsset: input.quoteAsset,
      priceInQuote,
      pairUsdg,
      quality: pairUsdg == null ? 'PARTIAL' : 'DERIVED',
    }
  }
  if (pairDelta < 0 && quoteDelta > 0) {
    return {
      side: 'SELL',
      pairDelta,
      quoteDelta,
      quoteAsset: input.quoteAsset,
      priceInQuote,
      pairUsdg,
      quality: pairUsdg == null ? 'PARTIAL' : 'DERIVED',
    }
  }
  return {
    side: Math.abs(pairDelta) < 1e-12 && Math.abs(quoteDelta) < 1e-12 ? 'UNCHANGED' : 'MIXED',
    pairDelta,
    quoteDelta,
    quoteAsset: input.quoteAsset,
    priceInQuote: null,
    pairUsdg: null,
    quality: 'DERIVED',
  }
}

/**
 * Reconcile an existing-position liquidity increase. The position's total
 * underlying increase can exceed the wallet's token outflow only when value
 * already held inside the position (normally accrued fees) is compounded.
 *
 * @param {{
 *   totalUnderlying: Partial<Amounts>,
 *   walletFlow: Partial<Amounts>,
 *   assets: Array<keyof Amounts>,
 *   tolerance?: Partial<Record<keyof Amounts, number>>,
 * }} input
 * @returns {{walletSpend: Amounts, implicitFees: Amounts}}
 */
export function deriveImplicitIncreaseFees(input) {
  const walletSpend = { ...EMPTY_AMOUNTS }
  const implicitFees = { ...EMPTY_AMOUNTS }
  const defaultTolerance = { eth: 1e-12, spy: 1e-12, pair: 1e-9, usdg: 1e-7, one: 1e-9 }
  for (const asset of input.assets) {
    walletSpend[asset] = Math.max(0, -Number(input.walletFlow[asset] || 0))
    const candidate = Math.max(0, Number(input.totalUnderlying[asset] || 0) - walletSpend[asset])
    implicitFees[asset] = candidate > Number(input.tolerance?.[asset] ?? defaultTolerance[asset]) ? candidate : 0
  }
  return { walletSpend, implicitFees }
}

/** @param {unknown} value */
function csvCell(value) {
  if (value == null) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {string[]} columns
 */
export function toCsv(rows, columns) {
  return (
    [
      columns.map(csvCell).join(','),
      ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
    ].join('\n') + '\n'
  )
}
