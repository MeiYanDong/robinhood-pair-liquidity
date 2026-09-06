import fs from 'node:fs'

const TOKEN_FIELDS = ['eth', 'spy', 'pair', 'usdg', 'one']

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function optionalNumber(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function emptyAmounts() {
  return { eth: 0, spy: 0, pair: 0, usdg: 0, one: 0 }
}

function addAmounts(left = {}, right = {}) {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, finite(left[field]) + finite(right[field])]))
}

function sumAmounts(items) {
  return items.reduce((total, item) => addAmounts(total, item), emptyAmounts())
}

function amountValueUsdg(amounts = {}, prices = {}) {
  const known = {
    eth: prices.ethUsdg,
    spy: prices.spyUsdg,
    pair: prices.pairUsdg,
    usdg: 1,
    one: prices.oneUsdg,
  }
  let total = 0
  const unknown = []
  for (const field of TOKEN_FIELDS) {
    const quantity = finite(amounts[field])
    if (!quantity) continue
    const rawMark = known[field]
    const mark = Number(rawMark)
    if (rawMark == null || !Number.isFinite(mark)) unknown.push(field)
    else total += quantity * mark
  }
  return { value: total, unknown }
}

function rangeFor(position, prices) {
  if (position.poolKind === 'pair-spy' && Number.isFinite(prices.spyUsdg)) {
    const at = (tick) => prices.spyUsdg / Math.pow(1.0001, tick)
    return {
      low: Math.min(at(position.tickLower), at(position.tickUpper)),
      high: Math.max(at(position.tickLower), at(position.tickUpper)),
      quality: 'live_spy_mark',
    }
  }
  if (position.poolKind === 'pair-usdg' || position.poolKind === 'one-usdg') {
    const token1Price = (tick) => Math.pow(10, 12) / Math.pow(1.0001, tick)
    return {
      low: Math.min(token1Price(position.tickLower), token1Price(position.tickUpper)),
      high: Math.max(token1Price(position.tickLower), token1Price(position.tickUpper)),
      quality: 'tick_math',
    }
  }
  if (Number.isFinite(position.entryRange?.low) && Number.isFinite(position.entryRange?.high)) {
    return {
      low: Number(position.entryRange.low),
      high: Number(position.entryRange.high),
      quality: position.entryRange.quality || 'recorded_at_entry',
    }
  }
  return { low: null, high: null, quality: 'unknown' }
}

function valueSupplyEvent(event, prices) {
  const explicitValue = optionalNumber(event.valueUsdg)
  if (Number.isFinite(explicitValue)) {
    return { value: explicitValue, quality: event.valueQuality || 'recorded' }
  }
  const marks = {
    ethUsdg: optionalNumber(event.mark?.ethUsdg),
    spyUsdg: optionalNumber(event.mark?.spyUsdg),
    pairUsdg: optionalNumber(event.mark?.pairUsdg),
    oneUsdg: optionalNumber(event.mark?.oneUsdg),
  }
  const marked = amountValueUsdg(event.amounts, marks)
  if (!marked.unknown.length && marked.value > 0) {
    return { value: marked.value, quality: event.mark?.quality || 'event_mark' }
  }
  const replacement = amountValueUsdg(event.amounts, prices)
  return {
    value: replacement.value,
    quality: replacement.unknown.length ? 'partial_current_replacement' : 'current_replacement_not_cost',
  }
}

function claimReplacementValue(claim, prices) {
  const valued = amountValueUsdg(claim.amounts, prices)
  return {
    ...claim,
    replacementValueUsdg: valued.value,
    replacementValueUnknownAssets: valued.unknown,
  }
}

const EVIDENCE_ORDER = Object.freeze({
  UNKNOWN: 0,
  PARTIAL: 1,
  DERIVED: 2,
  VERIFIED: 3,
})

function evidenceLevel(value, fallback = 'UNKNOWN') {
  const normalized = String(value || '').toLowerCase()
  if (!normalized) return fallback
  if (normalized.includes('unknown') || normalized.includes('unavailable')) return 'UNKNOWN'
  if (normalized.includes('partial') || normalized.includes('gross_includes')) return 'PARTIAL'
  if (normalized.includes('verified')) return 'VERIFIED'
  return 'DERIVED'
}

function weakestEvidence(...levels) {
  const usable = levels.filter((level) => level && level in EVIDENCE_ORDER)
  if (!usable.length) return 'UNKNOWN'
  return usable.reduce(
    (weakest, level) => (EVIDENCE_ORDER[level] < EVIDENCE_ORDER[weakest] ? level : weakest),
    usable[0],
  )
}

function eventHistoricalValue(event) {
  const explicit = optionalNumber(event?.valueUsdg)
  if (Number.isFinite(explicit)) {
    return { value: explicit, quality: evidenceLevel(event.valueQuality || 'recorded') }
  }
  const marked = amountValueUsdg(event?.amounts, {
    ethUsdg: optionalNumber(event?.mark?.ethUsdg),
    spyUsdg: optionalNumber(event?.mark?.spyUsdg),
    pairUsdg: optionalNumber(event?.mark?.pairUsdg),
    oneUsdg: optionalNumber(event?.mark?.oneUsdg),
  })
  return marked.unknown.length ? { value: null, quality: 'UNKNOWN' } : { value: marked.value, quality: 'DERIVED' }
}

function entryMarketSummary(position) {
  const events = position.supplyEvents || []
  const marked = events.flatMap((event) => {
    const pairUsdg = Number(event?.mark?.pairUsdg)
    const historicalValue = eventHistoricalValue(event)
    if (
      !Number.isFinite(pairUsdg) ||
      pairUsdg <= 0 ||
      !Number.isFinite(historicalValue.value) ||
      historicalValue.value <= 0
    ) {
      return []
    }
    return [{ pairUsdg, weightUsdg: historicalValue.value }]
  })
  const weight = marked.reduce((sum, event) => sum + event.weightUsdg, 0)
  const pairUsdg =
    weight > 0 ? marked.reduce((sum, event) => sum + event.pairUsdg * event.weightUsdg, 0) / weight : null
  return {
    pairUsdg,
    quality: !marked.length ? 'UNKNOWN' : marked.length === events.length ? 'DERIVED' : 'PARTIAL',
    markedEvents: marked.length,
    totalEvents: events.length,
    coveragePct: events.length ? (marked.length / events.length) * 100 : 0,
    method: 'capital_weighted_supply_event_market_marks',
  }
}

export function timeWeightedPrice(history, requestedFrom, requestedTo) {
  const fromMs = Date.parse(requestedFrom || '')
  const toMs = Date.parse(requestedTo || '')
  const coverageFromMs = Date.parse(history?.fromTime || '')
  const coverageToMs = Date.parse(history?.toTime || '')
  const points = (history?.points || [])
    .map((point) => ({ atMs: Date.parse(point.at || ''), pairUsdg: Number(point.pairUsdg) }))
    .filter((point) => Number.isFinite(point.atMs) && Number.isFinite(point.pairUsdg) && point.pairUsdg > 0)
    .sort((left, right) => left.atMs - right.atMs)
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    toMs <= fromMs ||
    !Number.isFinite(coverageFromMs) ||
    !Number.isFinite(coverageToMs) ||
    !points.length
  ) {
    return {
      pairUsdg: null,
      quality: 'UNKNOWN',
      coveragePct: 0,
      observedSeconds: 0,
      requestedSeconds: Number.isFinite(fromMs) && Number.isFinite(toMs) ? Math.max(0, (toMs - fromMs) / 1_000) : 0,
      method: 'time_weighted_canonical_market_marks',
    }
  }
  const effectiveFrom = Math.max(fromMs, coverageFromMs)
  const effectiveTo = Math.min(toMs, coverageToMs)
  const requestedSeconds = (toMs - fromMs) / 1_000
  if (effectiveTo <= effectiveFrom) {
    return {
      pairUsdg: null,
      quality: 'UNKNOWN',
      coveragePct: 0,
      observedSeconds: 0,
      requestedSeconds,
      method: 'time_weighted_canonical_market_marks',
    }
  }
  let current = null
  let cursor = effectiveFrom
  let area = 0
  for (const point of points) {
    if (point.atMs <= effectiveFrom) {
      current = point.pairUsdg
      continue
    }
    if (point.atMs > effectiveTo) break
    if (current != null) area += current * (point.atMs - cursor)
    current = point.pairUsdg
    cursor = point.atMs
  }
  if (current == null) {
    return {
      pairUsdg: null,
      quality: 'UNKNOWN',
      coveragePct: 0,
      observedSeconds: 0,
      requestedSeconds,
      method: 'time_weighted_canonical_market_marks',
    }
  }
  area += current * (effectiveTo - cursor)
  const observedSeconds = (effectiveTo - effectiveFrom) / 1_000
  const coveragePct = requestedSeconds > 0 ? Math.min(100, (observedSeconds / requestedSeconds) * 100) : 0
  return {
    pairUsdg: area / (effectiveTo - effectiveFrom),
    quality: coveragePct >= 99.99 ? 'DERIVED' : 'PARTIAL',
    coveragePct,
    observedSeconds,
    requestedSeconds,
    effectiveFromTime: new Date(effectiveFrom).toISOString(),
    effectiveToTime: new Date(effectiveTo).toISOString(),
    method: 'time_weighted_canonical_market_marks',
  }
}

function exitInventory(position, principal) {
  if (position.status === 'active') {
    return {
      amounts: addAmounts(emptyAmounts(), principal),
      quality: evidenceLevel(position.dataQuality, 'PARTIAL'),
      source: 'current_principal_same_safe_block',
      includesTerminalFees: false,
    }
  }
  if (position.exit?.principalAmounts) {
    return {
      amounts: addAmounts(emptyAmounts(), position.exit.principalAmounts),
      quality: evidenceLevel(position.exit.amountQuality),
      source: 'exit_principal_fees_separated',
      includesTerminalFees: false,
    }
  }
  if (position.exit?.grossAmounts) {
    return {
      amounts: addAmounts(emptyAmounts(), position.exit.grossAmounts),
      quality: 'PARTIAL',
      source: 'exit_gross_includes_unallocated_fees',
      includesTerminalFees: true,
    }
  }
  return {
    amounts: null,
    quality: 'UNKNOWN',
    source: 'exit_assets_unknown',
    includesTerminalFees: false,
  }
}

function endpointMarket(position, prices, safeTime) {
  if (position.status === 'active') {
    const pairUsdg = optionalNumber(prices.pairUsdg)
    return {
      kind: 'CURRENT',
      at: safeTime,
      pairUsdg,
      spyUsdg: optionalNumber(prices.spyUsdg),
      oneUsdg: optionalNumber(prices.oneUsdg),
      quality: Number.isFinite(pairUsdg) ? 'VERIFIED' : 'UNKNOWN',
    }
  }
  const mark = position.exit?.mark || {}
  const pairUsdg = optionalNumber(mark.pairUsdg)
  return {
    kind: 'EXIT',
    at: position.exit?.at || null,
    pairUsdg,
    spyUsdg: optionalNumber(mark.spyUsdg),
    oneUsdg: optionalNumber(mark.oneUsdg),
    quality: Number.isFinite(pairUsdg) ? evidenceLevel(mark.quality) : 'UNKNOWN',
  }
}

function implicitPairExecution(position, supplied, inventory, endpoint) {
  if (!inventory.amounts || !['pair-spy', 'pair-usdg'].includes(position.poolKind)) {
    return { side: 'UNKNOWN', pairUsdg: null, quality: 'UNKNOWN' }
  }
  const quoteAsset = position.poolKind === 'pair-spy' ? 'spy' : 'usdg'
  const quoteUsdg = quoteAsset === 'spy' ? endpoint.spyUsdg : 1
  const pairDelta = finite(inventory.amounts.pair) - finite(supplied.pair)
  const quoteDelta = finite(inventory.amounts[quoteAsset]) - finite(supplied[quoteAsset])
  const pairTolerance = Math.max(1e-12, Math.abs(finite(supplied.pair)) * 1e-12)
  const quoteTolerance = Math.max(1e-12, Math.abs(finite(supplied[quoteAsset])) * 1e-12)
  if (Math.abs(pairDelta) <= pairTolerance || Math.abs(quoteDelta) <= quoteTolerance || pairDelta * quoteDelta >= 0) {
    return {
      side: 'NONE',
      pairUsdg: null,
      pairDelta,
      quoteDelta,
      quoteAsset: quoteAsset.toUpperCase(),
      quality: weakestEvidence(inventory.quality, endpoint.quality),
      method: 'net_principal_inventory_change_fees_excluded',
    }
  }
  const priceInQuote = Math.abs(quoteDelta) / Math.abs(pairDelta)
  const pairUsdg = Number.isFinite(quoteUsdg) ? priceInQuote * quoteUsdg : null
  return {
    side: pairDelta > 0 ? 'BUY' : 'SELL',
    pairUsdg,
    priceInQuote,
    pairDelta,
    quoteDelta,
    quoteAsset: quoteAsset.toUpperCase(),
    quality: Number.isFinite(pairUsdg) ? weakestEvidence(inventory.quality, endpoint.quality) : 'UNKNOWN',
    method: inventory.includesTerminalFees
      ? 'net_exit_inventory_change_including_unallocated_fees'
      : 'net_principal_inventory_change_fees_excluded',
  }
}

function historicalClaimSummary(position, claims, endpoint) {
  const exitHash = position.exit?.transactionHash?.toLowerCase()
  let valueUsdg = 0
  let known = 0
  let unknown = 0
  let exitClaimRecorded = false
  for (const claim of claims) {
    const valued = eventHistoricalValue(claim)
    if (Number.isFinite(valued.value)) {
      valueUsdg += valued.value
      known += 1
    } else unknown += 1
    if (exitHash && claim.transactionHash?.toLowerCase() === exitHash) exitClaimRecorded = true
  }
  if (position.exit?.terminalFeeAmounts && !exitClaimRecorded) {
    const terminal = amountValueUsdg(position.exit.terminalFeeAmounts, {
      spyUsdg: endpoint.spyUsdg,
      pairUsdg: endpoint.pairUsdg,
      usdg: 1,
      oneUsdg: endpoint.oneUsdg,
    })
    if (terminal.unknown.length) unknown += 1
    else {
      valueUsdg += terminal.value
      known += 1
    }
  }
  return {
    valueUsdg,
    quality: unknown ? (known ? 'PARTIAL' : 'UNKNOWN') : 'DERIVED',
    knownRecords: known,
    unknownRecords: unknown,
    exitClaimRecorded,
  }
}

function buildPriceLedger({
  position,
  principal,
  supplied,
  claims,
  prices,
  entryValue,
  history,
  safeTime,
  feeCoverage,
}) {
  const openedAt = position.supplyEvents?.find((event) => event.at)?.at || position.mint?.at || null
  const endedAt = position.status === 'active' ? safeTime : position.exit?.at || null
  const openedMs = Date.parse(openedAt || '')
  const endedMs = Date.parse(endedAt || '')
  const holdingSeconds =
    Number.isFinite(openedMs) && Number.isFinite(endedMs) && endedMs >= openedMs ? (endedMs - openedMs) / 1_000 : null
  const entry = entryMarketSummary(position)
  const holding = timeWeightedPrice(history, openedAt, endedAt)
  const endpoint = endpointMarket(position, prices, safeTime)
  const inventory = exitInventory(position, principal)
  const execution = implicitPairExecution(position, supplied, inventory, endpoint)
  const feeSummary = historicalClaimSummary(position, claims, endpoint)

  let markedResult = {
    valueUsdg: null,
    pnlUsdg: null,
    pnlPct: null,
    quality: 'UNKNOWN',
    method: 'nft_local_exit_mark_minus_supply_event_cost',
  }
  if (position.status === 'empty' && inventory.amounts && endpoint.at) {
    const inventoryValue = amountValueUsdg(inventory.amounts, {
      spyUsdg: endpoint.spyUsdg,
      pairUsdg: endpoint.pairUsdg,
      usdg: 1,
      oneUsdg: endpoint.oneUsdg,
    })
    const entryKnown = entryValue.quality === 'event_cost_or_mark' && Number.isFinite(entryValue.value)
    const feesOutsideInventory = inventory.includesTerminalFees
      ? claims
          .filter((claim) => claim.transactionHash?.toLowerCase() !== position.exit?.transactionHash?.toLowerCase())
          .map(eventHistoricalValue)
      : null
    const outsideFeesValue = feesOutsideInventory
      ? feesOutsideInventory.reduce((sum, fee) => sum + (Number.isFinite(fee.value) ? fee.value : 0), 0)
      : feeSummary.valueUsdg
    const outsideFeesKnown = feesOutsideInventory
      ? feesOutsideInventory.every((fee) => Number.isFinite(fee.value))
      : feeSummary.quality !== 'UNKNOWN'
    if (entryKnown && !inventoryValue.unknown.length && outsideFeesKnown) {
      const valueUsdg = inventoryValue.value + outsideFeesValue
      const pnlUsdg = valueUsdg - entryValue.value
      markedResult = {
        valueUsdg,
        pnlUsdg,
        pnlPct: entryValue.value > 0 ? (pnlUsdg / entryValue.value) * 100 : null,
        quality: weakestEvidence(inventory.quality, endpoint.quality, feeSummary.quality),
        method: 'nft_local_exit_mark_plus_recorded_fees_minus_supply_event_cost',
      }
    }
  }

  let feeAdjustedExecutionPairUsdg = null
  let feeAdjustedExecutionQuality = 'UNKNOWN'
  if (Number.isFinite(execution.pairUsdg) && Math.abs(execution.pairDelta) > 0 && feeSummary.valueUsdg > 0) {
    const baseNotional = execution.pairUsdg * Math.abs(execution.pairDelta)
    feeAdjustedExecutionPairUsdg =
      execution.side === 'BUY'
        ? Math.max(0, baseNotional - feeSummary.valueUsdg) / Math.abs(execution.pairDelta)
        : (baseNotional + feeSummary.valueUsdg) / Math.abs(execution.pairDelta)
    feeAdjustedExecutionQuality = String(feeCoverage || '')
      .toLowerCase()
      .startsWith('verified')
      ? weakestEvidence(execution.quality, feeSummary.quality)
      : 'PARTIAL'
  }

  return {
    openedAt,
    endedAt,
    holdingSeconds,
    entry,
    holding,
    endpoint,
    inventory: {
      source: inventory.source,
      quality: inventory.quality,
      amounts: inventory.amounts,
    },
    implicitExecution: {
      ...execution,
      feeAdjustedPairUsdg: feeAdjustedExecutionPairUsdg,
      feeAdjustedQuality: feeAdjustedExecutionQuality,
    },
    recordedFeesAtEventMarks: feeSummary,
    markedResult,
    overallQuality: weakestEvidence(entry.quality, holding.quality, endpoint.quality, inventory.quality),
    meaning:
      'NFT-local price path; entry market, holding TWAP, LP inventory execution and fee-adjusted result are distinct metrics',
  }
}

function livePrincipal(snapshot, poolKind) {
  if (!snapshot?.principal) return emptyAmounts()
  if (poolKind === 'pair-spy') {
    return { ...emptyAmounts(), spy: finite(snapshot.principal.spy), pair: finite(snapshot.principal.pair) }
  }
  if (poolKind === 'pair-usdg') {
    return { ...emptyAmounts(), usdg: finite(snapshot.principal.usdgToken), pair: finite(snapshot.principal.pair) }
  }
  if (poolKind === 'one-usdg') {
    return { ...emptyAmounts(), usdg: finite(snapshot.principal.usdgToken), one: finite(snapshot.principal.one) }
  }
  return emptyAmounts()
}

function liveFees(snapshot, poolKind) {
  if (!snapshot?.accruedFees) return emptyAmounts()
  if (poolKind === 'pair-spy') {
    return { ...emptyAmounts(), spy: finite(snapshot.accruedFees.spy), pair: finite(snapshot.accruedFees.pair) }
  }
  if (poolKind === 'pair-usdg') {
    return { ...emptyAmounts(), usdg: finite(snapshot.accruedFees.usdgToken), pair: finite(snapshot.accruedFees.pair) }
  }
  if (poolKind === 'one-usdg') {
    return { ...emptyAmounts(), usdg: finite(snapshot.accruedFees.usdgToken), one: finite(snapshot.accruedFees.one) }
  }
  return emptyAmounts()
}

function classifyBasis({ position, principal, fees, claims, supplied, prices, entryValue }) {
  const principalValue = amountValueUsdg(principal, prices)
  const feeValue = amountValueUsdg(fees, prices)
  const claimedValue = claims.reduce((sum, claim) => sum + claim.replacementValueUsdg, 0)
  const hodlValue = amountValueUsdg(supplied, prices)
  const lifecycleValue = principalValue.value + feeValue.value + claimedValue
  const pairAcquired = finite(principal.pair) - finite(supplied.pair)
  const spySpent = finite(supplied.spy) - finite(principal.spy)
  const usdgSpent = finite(supplied.usdg) - finite(principal.usdg)
  const impliedSpendUsdg = Math.max(0, spySpent) * finite(prices.spyUsdg) + Math.max(0, usdgSpent)
  const impliedPairBuyPriceUsdg = pairAcquired > 0 && impliedSpendUsdg > 0 ? impliedSpendUsdg / pairAcquired : null
  const nonPairCurrentValue = finite(principal.spy) * finite(prices.spyUsdg) + finite(principal.usdg)
  const pairBreakEvenAfterFeesUsdg =
    Number.isFinite(entryValue.value) && entryValue.quality === 'event_cost_or_mark' && finite(principal.pair) > 0
      ? Math.max(0, entryValue.value - claimedValue - feeValue.value - nonPairCurrentValue) / finite(principal.pair)
      : null
  const comparable =
    position.status === 'active' && !principalValue.unknown.length && !hodlValue.unknown.length && hodlValue.value > 0
  return {
    entryValueUsdg: entryValue.value,
    entryValueQuality: entryValue.quality,
    suppliedCurrentMarkUsdg: hodlValue.value,
    currentPrincipalUsdg: principalValue.value,
    currentUnclaimedUsdg: feeValue.value,
    claimedCurrentMarkUsdg: claimedValue,
    lifecycleValueUsdg: lifecycleValue,
    versusSuppliedHodlUsdg: comparable ? lifecycleValue - hodlValue.value : null,
    versusSuppliedHodlPct: comparable ? (lifecycleValue / hodlValue.value - 1) * 100 : null,
    impliedPairBuyPriceUsdg,
    pairBreakEvenAfterFeesUsdg,
    meaning: 'NFT-local lifecycle view; never sum entry values or lifecycle values across migrated/reinvested NFTs',
  }
}

export function loadPortfolioManifest(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.positions)) {
    throw new Error('LP portfolio manifest schema is unsupported')
  }
  return manifest
}

export function uniqueTransactions(transactions = []) {
  const byHash = new Map()
  for (const transaction of transactions) {
    if (!transaction?.hash) continue
    const key = transaction.hash.toLowerCase()
    const existing = byHash.get(key)
    if (!existing || existing.evidenceRank < (transaction.evidenceRank || 0)) {
      byHash.set(key, { ...existing, ...transaction })
    } else {
      byHash.set(key, { ...transaction, ...existing })
    }
  }
  return [...byHash.values()].sort((left, right) => Number(left.blockNumber || 0) - Number(right.blockNumber || 0))
}

export function totalGasWei(transactions = []) {
  return uniqueTransactions(transactions)
    .filter((transaction) => transaction.status === 'success' || transaction.status === 'reverted')
    .reduce((sum, transaction) => sum + BigInt(transaction.gasCostWei || 0), 0n)
}

export function buildPortfolioView({
  manifest,
  detailedPositions = [],
  chainStates = [],
  prices = {},
  walletBalances = emptyAmounts(),
  marketHistories = {},
  safeBlock,
}) {
  if (!manifest) return null
  const detailById = new Map(detailedPositions.map((position) => [String(position.tokenId), position]))
  const stateById = new Map(chainStates.map((position) => [String(position.tokenId), position]))
  const valuedClaims = (manifest.feeClaims || []).map((claim) => claimReplacementValue(claim, prices))
  const claimsByPosition = new Map()
  for (const claim of valuedClaims) {
    for (const tokenId of claim.sourceTokenIds || []) {
      const list = claimsByPosition.get(String(tokenId)) || []
      list.push(claim)
      claimsByPosition.set(String(tokenId), list)
    }
  }

  const positions = manifest.positions.map((position) => {
    const tokenId = String(position.tokenId)
    const detail = detailById.get(tokenId)
    const chain = stateById.get(tokenId) || {}
    const status = chain.status || detail?.status || position.lastKnownStatus || 'unknown'
    const principal = livePrincipal(detail, position.poolKind)
    const unclaimed = liveFees(detail, position.poolKind)
    const supplied = sumAmounts((position.supplyEvents || []).map((event) => event.amounts))
    const entryValues = (position.supplyEvents || []).map((event) => valueSupplyEvent(event, prices))
    const allEntryKnown =
      entryValues.length > 0 &&
      entryValues.every(
        (item) => item.quality !== 'partial_current_replacement' && item.quality !== 'current_replacement_not_cost',
      )
    const entryValue = {
      value: entryValues.reduce((sum, item) => sum + item.value, 0),
      quality: allEntryKnown ? 'event_cost_or_mark' : entryValues.length ? 'partial' : 'unknown',
    }
    const claims = claimsByPosition.get(tokenId) || []
    const range = rangeFor(position, prices)
    const normalized = {
      ...position,
      status,
      owner: chain.owner || detail?.owner || null,
      liquidity: chain.liquidity ?? detail?.liquidity ?? '0',
      inRange: Boolean(detail?.inRange),
      currentRange: range,
      principal,
      unclaimedFees: unclaimed,
      supplied,
      claims,
      dataQuality: detail?.dataQuality || chain.dataQuality || 'partial',
    }
    const accounting = classifyBasis({
      position: normalized,
      principal,
      fees: unclaimed,
      claims,
      supplied,
      prices,
      entryValue,
    })
    const history = marketHistories[position.poolId] || marketHistories[position.poolKind] || null
    return {
      ...normalized,
      accounting,
      priceLedger: buildPriceLedger({
        position: normalized,
        principal,
        supplied,
        claims,
        prices,
        entryValue,
        history,
        safeTime: safeBlock?.time || null,
        feeCoverage: manifest.coverage?.claimedFees,
      }),
    }
  })

  const active = positions.filter((position) => position.status === 'active')
  const empty = positions.filter((position) => position.status === 'empty')
  const missing = positions.filter((position) => !['active', 'empty'].includes(position.status))
  const activePrincipal = sumAmounts(active.map((position) => position.principal))
  const unclaimedFees = sumAmounts(active.map((position) => position.unclaimedFees))
  const claimedFees = sumAmounts(valuedClaims.map((claim) => claim.amounts))
  const principalValue = amountValueUsdg(activePrincipal, prices)
  const unclaimedValue = amountValueUsdg(unclaimedFees, prices)
  const claimedValue = amountValueUsdg(claimedFees, prices)
  const walletValue = amountValueUsdg(walletBalances, prices)
  const transactions = uniqueTransactions(manifest.transactions)
  const gasWei = totalGasWei(transactions)
  const gasEth = Number(gasWei) / 1e18
  const gasUsdgCurrentMark = Number.isFinite(prices.ethUsdg) ? gasEth * prices.ethUsdg : null
  const lpDirectedEth = transactions
    .filter((transaction) => transaction.status === 'success' && transaction.capitalFlow === 'lp_directed')
    .reduce((sum, transaction) => sum + finite(transaction.valueEth), 0)
  const confirmedReceipts = transactions.filter((transaction) => transaction.status === 'success').length
  const revertedReceipts = transactions.filter((transaction) => transaction.status === 'reverted').length
  const activeWithoutValuation = active.filter((position) => !detailById.has(String(position.tokenId)))
  const priceLedgerCoverage = {
    entryMarket: positions.filter((position) => Number.isFinite(position.priceLedger?.entry?.pairUsdg)).length,
    holdingTwap: positions.filter((position) => Number.isFinite(position.priceLedger?.holding?.pairUsdg)).length,
    endpointMarket: positions.filter((position) => Number.isFinite(position.priceLedger?.endpoint?.pairUsdg)).length,
    implicitExecution: positions.filter((position) =>
      Number.isFinite(position.priceLedger?.implicitExecution?.pairUsdg),
    ).length,
    closedExitAssets: empty.filter((position) => position.priceLedger?.inventory?.amounts).length,
    total: positions.length,
  }

  return {
    schemaVersion: 1,
    explorerTxBaseUrl: manifest.explorerTxBaseUrl || null,
    generatedFromManifestAt: manifest.generatedAt,
    asOfBlock: String(safeBlock?.number ?? manifest.audit?.safeBlock ?? ''),
    asOfTime: safeBlock?.time || null,
    prices,
    totals: {
      lifecycleNfts: positions.length,
      activeNfts: active.length,
      emptyNfts: empty.length,
      exceptionNfts: missing.length,
      activePrincipal: activePrincipal,
      activePrincipalUsdg: principalValue.value,
      unclaimedFees,
      unclaimedFeesUsdg: unclaimedValue.value,
      recordedClaimedFees: claimedFees,
      recordedClaimedFeesCurrentMarkUsdg: claimedValue.value,
      recordedLifetimeFeesCurrentMarkUsdg: claimedValue.value + unclaimedValue.value,
      walletBalances,
      walletBalancesUsdg: walletValue.value,
      gasWei: gasWei.toString(),
      gasEth,
      gasUsdgCurrentMark,
      lpDirectedEthObserved: lpDirectedEth,
      confirmedReceipts,
      revertedReceipts,
    },
    positions,
    lineages: manifest.lineages || [],
    feeClaims: valuedClaims,
    transactions,
    recentTransactions: transactions.slice(-16).reverse(),
    audit: manifest.audit,
    accountingBoundary: {
      aggregateCashInvested: 'PARTIAL',
      reason:
        'Native-ETH top-ups and pre-existing wallet tokens are not fully attributable from local execution records alone.',
      nftEntryValuesAreAdditive: false,
      claimedFeeCoverage: manifest.coverage?.claimedFees || 'partial',
      activeValuation: activeWithoutValuation.length ? 'partial' : 'verified',
      chainInventory: manifest.audit?.inventoryStatus || 'unknown',
      historicalPriceLedger: priceLedgerCoverage,
    },
    caveats: manifest.caveats || [],
  }
}

export const portfolioInternals = {
  addAmounts,
  amountValueUsdg,
  classifyBasis,
  emptyAmounts,
  rangeFor,
  sumAmounts,
  valueSupplyEvent,
}
