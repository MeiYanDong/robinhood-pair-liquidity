/**
 * @param {{status: string, generatedAt?: string | null, refreshMs: number, hasSucceededSinceStart?: boolean, nowMs?: number}} input
 */
export function evaluateRuntimeStatus({
  status,
  generatedAt,
  refreshMs,
  hasSucceededSinceStart = true,
  nowMs = Date.now(),
}) {
  const parsedGeneratedAt = generatedAt ? Date.parse(generatedAt) : Number.NaN
  const ageSeconds = Number.isFinite(parsedGeneratedAt) ? Math.max(0, (nowMs - parsedGeneratedAt) / 1_000) : null
  const staleAfterSeconds = Math.ceil((refreshMs * 3) / 1_000)
  const hasFreshSnapshot = ageSeconds != null && ageSeconds <= staleAfterSeconds
  const effectiveStatus = hasFreshSnapshot
    ? status === 'STALE' || status === 'ERROR'
      ? 'DEGRADED'
      : status
    : generatedAt
      ? 'STALE'
      : status
  const ready = hasFreshSnapshot && hasSucceededSinceStart
  return { status: effectiveStatus, ready, ageSeconds, staleAfterSeconds }
}
