/**
 * @typedef {object} WindowTotals
 * @property {number} [volumeUsdg]
 * @property {number} [spyInput]
 * @property {number} [pairInput]
 *
 * @typedef {object} LiquidityBin
 * @property {number} tickLower
 * @property {number} tickUpper
 * @property {number} [priceLowUsdg]
 * @property {number} [priceHighUsdg]
 * @property {number} [priceMidUsdg]
 * @property {number} [volumeUsdg]
 * @property {number} [grossFeeUsdg]
 * @property {string|number|bigint} [marketLiquidity]
 */

/** @param {unknown} value */
function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** @param {unknown} value */
function approximateLiquidity(value) {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(String(value ?? 0))
    if (parsed < 0n) return null
    const numeric = Number(parsed)
    return Number.isFinite(numeric) ? numeric : null
  } catch {
    return null
  }
}

/** @param {WindowTotals} totals @param {number} spyUsdg @param {number} pairUsdg */
function pairBuyShare(totals, spyUsdg, pairUsdg) {
  const spyInput = finiteNonNegative(totals.spyInput)
  const pairInput = finiteNonNegative(totals.pairInput)
  if (spyInput === null || pairInput === null || spyUsdg <= 0 || pairUsdg <= 0) return null
  const pairBuyUsdg = spyInput * spyUsdg
  const pairSellUsdg = pairInput * pairUsdg
  const total = pairBuyUsdg + pairSellUsdg
  return total > 0 ? (pairBuyUsdg / total) * 100 : null
}

/**
 * @param {{oneHourTotals:WindowTotals,sixHourTotals:WindowTotals,spyUsdg:number,pairUsdg:number}} input
 */
export function deriveFlowSignals({ oneHourTotals, sixHourTotals, spyUsdg, pairUsdg }) {
  const oneHourVolumeUsdg = finiteNonNegative(oneHourTotals.volumeUsdg)
  const sixHourVolumeUsdg = finiteNonNegative(sixHourTotals.volumeUsdg)
  const hourlySixHourBaselineUsdg = sixHourVolumeUsdg === null ? null : sixHourVolumeUsdg / 6
  const volumeMultiple =
    oneHourVolumeUsdg !== null && hourlySixHourBaselineUsdg !== null && hourlySixHourBaselineUsdg > 0
      ? oneHourVolumeUsdg / hourlySixHourBaselineUsdg
      : null
  const oneHourPairBuySharePct = pairBuyShare(oneHourTotals, spyUsdg, pairUsdg)
  const sixHourPairBuySharePct = pairBuyShare(sixHourTotals, spyUsdg, pairUsdg)
  return {
    dataComplete:
      oneHourVolumeUsdg !== null &&
      sixHourVolumeUsdg !== null &&
      volumeMultiple !== null &&
      oneHourPairBuySharePct !== null &&
      sixHourPairBuySharePct !== null,
    oneHourVolumeUsdg,
    sixHourVolumeUsdg,
    hourlySixHourBaselineUsdg,
    volumeMultiple,
    oneHourPairBuySharePct,
    sixHourPairBuySharePct,
    valuationMethod: 'current_mark_directional_approximation',
  }
}

/** @param {number} spyUsdg @param {number} tick */
function pairPriceAtTick(spyUsdg, tick) {
  return spyUsdg / Math.pow(1.0001, tick)
}

/** @param {number} spyUsdg @param {number} pairUsdg */
function tickAtPairPrice(spyUsdg, pairUsdg) {
  return Math.log(spyUsdg / pairUsdg) / Math.log(1.0001)
}

/** @param {number} tick @param {number} spacing */
function alignDown(tick, spacing) {
  return Math.floor(tick / spacing) * spacing
}

/** @param {number} tick @param {number} spacing */
function alignUp(tick, spacing) {
  return Math.ceil(tick / spacing) * spacing
}

/** @param {LiquidityBin[]} bins @param {number} quantile */
function weightedPriceQuantile(bins, quantile) {
  const ordered = bins
    .filter((bin) => Number(bin.volumeUsdg) > 0 && Number.isFinite(Number(bin.priceMidUsdg)))
    .sort((left, right) => Number(left.priceMidUsdg) - Number(right.priceMidUsdg))
  const total = ordered.reduce((sum, bin) => sum + Number(bin.volumeUsdg), 0)
  if (total <= 0) return null
  const threshold = total * quantile
  let cumulative = 0
  for (const bin of ordered) {
    cumulative += Number(bin.volumeUsdg)
    if (cumulative >= threshold) return Number(bin.priceMidUsdg)
  }
  return Number(ordered.at(-1)?.priceMidUsdg) || null
}

/**
 * @param {LiquidityBin[]} bins
 * @param {number} tickLower
 * @param {number} tickUpper
 * @param {number} modeledAddedLiquidity
 */
function measureRange(bins, tickLower, tickUpper, modeledAddedLiquidity) {
  let allVolumeUsdg = 0
  let coveredVolumeUsdg = 0
  let modeledFeeCaptureUsdg = 0
  let shareWeight = 0
  let shareWeightedTotal = 0
  let validMarketBins = 0
  for (const bin of bins) {
    const volumeUsdg = finiteNonNegative(bin.volumeUsdg)
    if (volumeUsdg === null) continue
    allVolumeUsdg += volumeUsdg
    const binWidth = bin.tickUpper - bin.tickLower
    const overlap = Math.max(0, Math.min(bin.tickUpper, tickUpper) - Math.max(bin.tickLower, tickLower))
    if (binWidth <= 0 || overlap <= 0) continue
    const overlapFraction = overlap / binWidth
    const covered = volumeUsdg * overlapFraction
    coveredVolumeUsdg += covered
    const marketLiquidity = approximateLiquidity(bin.marketLiquidity)
    if (marketLiquidity === null || marketLiquidity <= 0 || modeledAddedLiquidity <= 0) continue
    const projectedShare = modeledAddedLiquidity / (marketLiquidity + modeledAddedLiquidity)
    const grossFeeUsdg = finiteNonNegative(bin.grossFeeUsdg) ?? volumeUsdg * 0.01
    modeledFeeCaptureUsdg += grossFeeUsdg * overlapFraction * projectedShare
    shareWeightedTotal += projectedShare * covered
    shareWeight += covered
    validMarketBins += 1
  }
  return {
    totalVolumeUsdg: allVolumeUsdg,
    coveredVolumeUsdg,
    coveragePct: allVolumeUsdg > 0 ? (coveredVolumeUsdg / allVolumeUsdg) * 100 : null,
    modeledFeeCaptureUsdg,
    modeledVolumeWeightedSharePct: shareWeight > 0 ? (shareWeightedTotal / shareWeight) * 100 : null,
    validMarketBins,
  }
}

/**
 * Select an upward-skewed PAIR/SPY range in price space. The target is around
 * $0.01 wide, not a hard minimum: the default candidate family is $0.008,
 * $0.010 and $0.012 before Tick-spacing rounding. Historical volume coverage,
 * market-liquidity competition and projected share determine the ranking.
 *
 * @param {{
 *   currentTick:number,
 *   tickSpacing:number,
 *   spyUsdg:number,
 *   oneHourBins:LiquidityBin[],
 *   sixHourBins:LiquidityBin[],
 *   referenceAddedLiquidity:string|number|bigint,
 *   targetPriceWidthUsdg?:number,
 *   targetWidthTolerancePct?:number,
 *   widthMultipliers?:number[],
 *   upsideRoomShares?:number[]
 * }} input
 */
export function selectUpwardRange({
  currentTick,
  tickSpacing,
  spyUsdg,
  oneHourBins,
  sixHourBins,
  referenceAddedLiquidity,
  targetPriceWidthUsdg = 0.01,
  targetWidthTolerancePct = 20,
  widthMultipliers = [0.8, 1, 1.2, 1.5],
  upsideRoomShares = [0.7, 0.8, 0.9, 1],
}) {
  if (!Number.isFinite(currentTick)) throw new TypeError('currentTick must be finite')
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new TypeError('tickSpacing must be a positive integer')
  }
  if (!Number.isFinite(spyUsdg) || spyUsdg <= 0) throw new TypeError('spyUsdg must be positive')
  if (!Number.isFinite(targetPriceWidthUsdg) || targetPriceWidthUsdg <= 0) {
    throw new TypeError('targetPriceWidthUsdg must be positive')
  }
  const referenceLiquidity = approximateLiquidity(referenceAddedLiquidity)
  if (referenceLiquidity === null) throw new TypeError('referenceAddedLiquidity must be non-negative')
  if (
    widthMultipliers.length === 0 ||
    widthMultipliers.some((multiplier) => !Number.isFinite(multiplier) || multiplier <= 0)
  ) {
    throw new TypeError('widthMultipliers must contain positive values')
  }
  if (
    upsideRoomShares.length === 0 ||
    upsideRoomShares.some((share) => !Number.isFinite(share) || share <= 0.5 || share > 1)
  ) {
    throw new TypeError('upsideRoomShares must be above 0.5 and at most 1')
  }

  const currentPairUsdg = pairPriceAtTick(spyUsdg, currentTick)
  const hotBand1hUsdg = {
    p10: weightedPriceQuantile(oneHourBins, 0.1),
    p50: weightedPriceQuantile(oneHourBins, 0.5),
    p90: weightedPriceQuantile(oneHourBins, 0.9),
  }
  const hotBand6hUsdg = {
    p10: weightedPriceQuantile(sixHourBins, 0.1),
    p50: weightedPriceQuantile(sixHourBins, 0.5),
    p90: weightedPriceQuantile(sixHourBins, 0.9),
  }
  const candidateByTicks = new Map()
  for (const multiplier of [...new Set(widthMultipliers)]) {
    const requestedPriceWidthUsdg = targetPriceWidthUsdg * multiplier
    const placements = upsideRoomShares.map((upsideRoomShare) => ({
      anchorSource: `current_price_${Math.round(upsideRoomShare * 100)}pct_upside`,
      upsideRoomShare,
      requestedPriceLowUsdg: currentPairUsdg - requestedPriceWidthUsdg * (1 - upsideRoomShare),
      requestedPriceHighUsdg: currentPairUsdg + requestedPriceWidthUsdg * upsideRoomShare,
    }))
    /** @type {Array<[string, typeof hotBand1hUsdg]>} */
    const hotBands = [
      ['1h', hotBand1hUsdg],
      ['6h', hotBand6hUsdg],
    ]
    for (const [windowId, hotBand] of hotBands) {
      if (typeof hotBand.p10 === 'number' && Number.isFinite(hotBand.p10)) {
        placements.push({
          anchorSource: `${windowId}_volume_p10_floor`,
          upsideRoomShare: (currentPairUsdg - hotBand.p10) / requestedPriceWidthUsdg,
          requestedPriceLowUsdg: hotBand.p10,
          requestedPriceHighUsdg: hotBand.p10 + requestedPriceWidthUsdg,
        })
      }
      if (typeof hotBand.p90 === 'number' && Number.isFinite(hotBand.p90)) {
        placements.push({
          anchorSource: `${windowId}_volume_p90_ceiling`,
          upsideRoomShare: (hotBand.p90 - currentPairUsdg) / requestedPriceWidthUsdg,
          requestedPriceLowUsdg: hotBand.p90 - requestedPriceWidthUsdg,
          requestedPriceHighUsdg: hotBand.p90,
        })
      }
    }
    for (const placement of placements) {
      const { anchorSource, requestedPriceLowUsdg, requestedPriceHighUsdg } = placement
      if (
        requestedPriceLowUsdg <= 0 ||
        currentPairUsdg < requestedPriceLowUsdg ||
        currentPairUsdg > requestedPriceHighUsdg
      ) {
        continue
      }
      const tickLower = alignDown(tickAtPairPrice(spyUsdg, requestedPriceHighUsdg), tickSpacing)
      const tickUpper = alignUp(tickAtPairPrice(spyUsdg, requestedPriceLowUsdg), tickSpacing)
      if (tickLower >= tickUpper || currentTick < tickLower || currentTick >= tickUpper) continue
      const candidateKey = `${tickLower}:${tickUpper}`
      const duplicate = candidateByTicks.get(candidateKey)
      if (duplicate) {
        if (!duplicate.anchorSources.includes(anchorSource)) duplicate.anchorSources.push(anchorSource)
        continue
      }
      const priceLowUsdg = pairPriceAtTick(spyUsdg, tickUpper)
      const priceHighUsdg = pairPriceAtTick(spyUsdg, tickLower)
      const actualPriceWidthUsdg = priceHighUsdg - priceLowUsdg
      const modeledAddedLiquidity =
        actualPriceWidthUsdg > 0 ? referenceLiquidity * (targetPriceWidthUsdg / actualPriceWidthUsdg) : 0
      const oneHour = measureRange(oneHourBins, tickLower, tickUpper, modeledAddedLiquidity)
      const sixHour = measureRange(sixHourBins, tickLower, tickUpper, modeledAddedLiquidity)
      const targetWidthDeviationPct =
        (Math.abs(actualPriceWidthUsdg - targetPriceWidthUsdg) / targetPriceWidthUsdg) * 100
      candidateByTicks.set(candidateKey, {
        tickLower,
        tickUpper,
        anchorSources: [anchorSource],
        widthTicks: tickUpper - tickLower,
        widthSteps: (tickUpper - tickLower) / tickSpacing,
        upsideRoomShare: Math.max(0, Math.min(1, placement.upsideRoomShare)),
        currentTickPositionPct: ((currentTick - tickLower) / (tickUpper - tickLower)) * 100,
        currentPricePositionPct: ((currentPairUsdg - priceLowUsdg) / actualPriceWidthUsdg) * 100,
        requestedPriceLowUsdg,
        requestedPriceHighUsdg,
        requestedPriceWidthUsdg,
        priceLowUsdg,
        priceHighUsdg,
        actualPriceWidthUsdg,
        targetWidthDeviationPct,
        insidePreferredWidthBand: targetWidthDeviationPct <= targetWidthTolerancePct,
        outsidePreferredWidthBand: targetWidthDeviationPct > targetWidthTolerancePct,
        modeledAddedLiquidity,
        oneHour,
        sixHour,
      })
    }
  }
  const candidates = [...candidateByTicks.values()]
  const maximumOneHourCapture = Math.max(...candidates.map((candidate) => candidate.oneHour.modeledFeeCaptureUsdg), 0)
  const scored = candidates
    .map((candidate) => {
      const coverageOne = (candidate.oneHour.coveragePct ?? 0) / 100
      const coverageSix = (candidate.sixHour.coveragePct ?? 0) / 100
      const captureScore =
        maximumOneHourCapture > 0 ? candidate.oneHour.modeledFeeCaptureUsdg / maximumOneHourCapture : 0
      const shareScore = Math.min((candidate.oneHour.modeledVolumeWeightedSharePct ?? 0) / 0.25, 1)
      const widthScore = Math.max(0, 1 - candidate.targetWidthDeviationPct / 100)
      const score =
        coverageOne * 0.3 +
        coverageSix * 0.25 +
        captureScore * 0.2 +
        shareScore * 0.1 +
        widthScore * 0.1 +
        candidate.upsideRoomShare * 0.05
      const qualificationChecks = {
        referenceLiquidity: referenceLiquidity > 0,
        oneHourMarketLiquidity: candidate.oneHour.validMarketBins > 0,
        sixHourMarketLiquidity: candidate.sixHour.validMarketBins > 0,
        widthWithinTolerance: candidate.targetWidthDeviationPct <= targetWidthTolerancePct + 5,
        oneHourVolumeCoverage: (candidate.oneHour.coveragePct ?? 0) >= 75,
        sixHourVolumeCoverage: (candidate.sixHour.coveragePct ?? 0) >= 50,
        modeledMarketShare: (candidate.oneHour.modeledVolumeWeightedSharePct ?? 0) >= 0.03,
      }
      const rejectionReasons = Object.entries(qualificationChecks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
      const qualified = rejectionReasons.length === 0
      return {
        ...candidate,
        score,
        scoreComponents: {
          oneHourVolumeCoverage: coverageOne * 0.3,
          sixHourVolumeCoverage: coverageSix * 0.25,
          modeledFeeCapture: captureScore * 0.2,
          modeledMarketShare: shareScore * 0.1,
          targetWidthAdherence: widthScore * 0.1,
          upsideRoom: candidate.upsideRoomShare * 0.05,
        },
        qualificationChecks,
        rejectionReasons,
        qualified,
      }
    })
    .sort((left, right) => right.score - left.score || left.targetWidthDeviationPct - right.targetWidthDeviationPct)
  const qualifiedSelection = scored.find((candidate) => candidate.qualified) ?? null
  const selected = qualifiedSelection ?? scored[0] ?? null
  let nextTarget = null
  if (qualifiedSelection) {
    const requestedPriceLowUsdg = qualifiedSelection.priceHighUsdg - targetPriceWidthUsdg * 0.1
    const requestedPriceHighUsdg = requestedPriceLowUsdg + targetPriceWidthUsdg
    const tickLower = alignDown(tickAtPairPrice(spyUsdg, requestedPriceHighUsdg), tickSpacing)
    const tickUpper = alignUp(tickAtPairPrice(spyUsdg, requestedPriceLowUsdg), tickSpacing)
    const priceLowUsdg = pairPriceAtTick(spyUsdg, tickUpper)
    const priceHighUsdg = pairPriceAtTick(spyUsdg, tickLower)
    const actualPriceWidthUsdg = priceHighUsdg - priceLowUsdg
    const modeledAddedLiquidity =
      actualPriceWidthUsdg > 0 ? referenceLiquidity * (targetPriceWidthUsdg / actualPriceWidthUsdg) : 0
    nextTarget = {
      status: 'PREPARE_ONLY',
      reason: 'next ladder band is displayed for continuity planning and is not an executable recommendation',
      tickLower,
      tickUpper,
      requestedPriceLowUsdg,
      requestedPriceHighUsdg,
      priceLowUsdg,
      priceHighUsdg,
      actualPriceWidthUsdg,
      targetWidthDeviationPct: (Math.abs(actualPriceWidthUsdg - targetPriceWidthUsdg) / targetPriceWidthUsdg) * 100,
      overlapWithActiveTargetUsdg: Math.max(0, qualifiedSelection.priceHighUsdg - priceLowUsdg),
      gapFromActiveTargetUsdg: Math.max(0, priceLowUsdg - qualifiedSelection.priceHighUsdg),
      modeledAddedLiquidity,
      oneHour: measureRange(oneHourBins, tickLower, tickUpper, modeledAddedLiquidity),
      sixHour: measureRange(sixHourBins, tickLower, tickUpper, modeledAddedLiquidity),
    }
  }

  return {
    selectionMethod: 'price_width_volume_anchoring_market_liquidity_and_modeled_share_v3',
    liquidityModel: 'equal_capital_inverse_price_width_approximation',
    currentPairUsdg,
    targetPriceWidthUsdg,
    targetWidthTolerancePct,
    preferredPriceWidthBandUsdg: {
      low: targetPriceWidthUsdg * (1 - targetWidthTolerancePct / 100),
      high: targetPriceWidthUsdg * (1 + targetWidthTolerancePct / 100),
    },
    hotBand1hUsdg,
    hotBand6hUsdg,
    status: qualifiedSelection ? 'QUALIFIED' : 'RESCAN_NO_TRADE',
    selectionExplanation: qualifiedSelection
      ? 'Highest-scoring qualified candidate after width, volume coverage, market-liquidity and modeled-share gates.'
      : 'No candidate passed every qualification gate; the leading candidate is displayed for diagnosis only.',
    selected,
    activeTarget: qualifiedSelection,
    nextTarget,
    anyQualified: scored.some((candidate) => candidate.qualified),
    candidates: scored,
    limitations: [
      'The target width is a tunable preference around $0.01, not a guaranteed minimum or maximum.',
      'Market liquidity and path-allocated swap volume come from the dashboard safe-block windows.',
      'Modeled added liquidity is comparative and is not an exact mint quote.',
      'Modeled fee capture is not promised realized revenue and excludes inventory PnL, gas and slippage.',
    ],
  }
}
