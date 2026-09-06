/** @param {bigint} value @param {string} label */
function requireNonNegativeBigInt(value, label) {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must be a non-negative bigint`)
  return value
}

/** @param {bigint} walletPairWei @param {bigint | null} [configuredCapWei] */
export function authorizedPairBudget(walletPairWei, configuredCapWei = null) {
  requireNonNegativeBigInt(walletPairWei, 'walletPairWei')
  if (configuredCapWei == null) return walletPairWei
  requireNonNegativeBigInt(configuredCapWei, 'configuredCapWei')
  if (configuredCapWei === 0n) throw new Error('configured PAIR budget must be greater than zero')
  return configuredCapWei < walletPairWei ? configuredCapWei : walletPairWei
}

/** @param {bigint} walletPairWei @param {bigint} authorizedBudgetWei */
export function protectedPairFloor(walletPairWei, authorizedBudgetWei) {
  requireNonNegativeBigInt(walletPairWei, 'walletPairWei')
  requireNonNegativeBigInt(authorizedBudgetWei, 'authorizedBudgetWei')
  if (authorizedBudgetWei > walletPairWei) throw new Error('authorized PAIR budget exceeds wallet balance')
  return walletPairWei - authorizedBudgetWei
}

/** @param {number} currentTick @param {number} targetTickUpper */
export function assertPairOnlyBoundary(currentTick, targetTickUpper) {
  if (!Number.isInteger(currentTick) || !Number.isInteger(targetTickUpper)) {
    throw new TypeError('ticks must be integers')
  }
  if (currentTick < targetTickUpper) {
    throw new Error(`target is not PAIR-only at current tick: current=${currentTick}, upper=${targetTickUpper}`)
  }
}

/**
 * @param {{baselinePairWei: bigint, finalPairWei: bigint, authorizedBudgetWei: bigint, minimumUseBps?: bigint}} options
 */
export function verifyAuthorizedPairSpend({
  baselinePairWei,
  finalPairWei,
  authorizedBudgetWei,
  minimumUseBps = 9_999n,
}) {
  requireNonNegativeBigInt(baselinePairWei, 'baselinePairWei')
  requireNonNegativeBigInt(finalPairWei, 'finalPairWei')
  requireNonNegativeBigInt(authorizedBudgetWei, 'authorizedBudgetWei')
  requireNonNegativeBigInt(minimumUseBps, 'minimumUseBps')
  if (minimumUseBps > 10_000n) throw new Error('minimumUseBps exceeds 100%')
  const spentWei = baselinePairWei > finalPairWei ? baselinePairWei - finalPairWei : 0n
  const floorWei = protectedPairFloor(baselinePairWei, authorizedBudgetWei)
  if (spentWei > authorizedBudgetWei || finalPairWei < floorWei) {
    throw new Error(`PAIR spend exceeded authorization: spent=${spentWei}, authorized=${authorizedBudgetWei}`)
  }
  if (spentWei * 10_000n < authorizedBudgetWei * minimumUseBps) {
    throw new Error(`PAIR budget use below minimum: spent=${spentWei}, authorized=${authorizedBudgetWei}`)
  }
  return { spentWei, floorWei }
}
