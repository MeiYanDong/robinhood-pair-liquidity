const SVG_NS = 'http://www.w3.org/2000/svg'
const state = {
  window: '24h',
  portfolioFilter: 'all',
  data: null,
  request: null,
  poll: null,
  snapshotKey: null,
}

const elements = {
  statusPill: document.querySelector('#status-pill'),
  blockLine: document.querySelector('#block-line'),
  freshnessLine: document.querySelector('#freshness-line'),
  pairPrice: document.querySelector('#pair-price'),
  pairTick: document.querySelector('#pair-tick'),
  activeShare: document.querySelector('#active-share'),
  activeLps: document.querySelector('#active-lps'),
  claimableFees: document.querySelector('#claimable-fees'),
  feeTokens: document.querySelector('#fee-tokens'),
  windowVolumeLabel: document.querySelector('#window-volume-label'),
  windowVolume: document.querySelector('#window-volume'),
  windowGrossFee: document.querySelector('#window-gross-fee'),
  strategyEvidence: document.querySelector('#strategy-evidence'),
  strategyWallet: document.querySelector('#strategy-wallet'),
  strategyPrice: document.querySelector('#strategy-price'),
  strategyBlock: document.querySelector('#strategy-block'),
  strategyPrincipal: document.querySelector('#strategy-principal'),
  strategyAssets: document.querySelector('#strategy-assets'),
  strategyFees: document.querySelector('#strategy-fees'),
  strategyFeeAssets: document.querySelector('#strategy-fee-assets'),
  strategyPositionCount: document.querySelector('#strategy-position-count'),
  strategyPositionStatus: document.querySelector('#strategy-position-status'),
  strategyIdle: document.querySelector('#strategy-idle'),
  strategyGas: document.querySelector('#strategy-gas'),
  strategyPositions: document.querySelector('#strategy-positions'),
  strategyNote: document.querySelector('#strategy-note'),
  trendEvidence: document.querySelector('#trend-evidence'),
  trendSignal: document.querySelector('#trend-signal'),
  trendCopy: document.querySelector('#trend-copy'),
  trendTarget: document.querySelector('#trend-target'),
  trendWidth: document.querySelector('#trend-width'),
  trendHotBand: document.querySelector('#trend-hot-band'),
  trendFlow: document.querySelector('#trend-flow'),
  trendCandidates: document.querySelector('#trend-candidates'),
  trendChart: document.querySelector('#trend-chart'),
  comparisonMethod: document.querySelector('#comparison-method'),
  decisionPanel: document.querySelector('#decision-panel'),
  decisionTitle: document.querySelector('#decision-title'),
  decisionCopy: document.querySelector('#decision-copy'),
  decisionGates: document.querySelector('#decision-gates'),
  migrationCost: document.querySelector('#migration-cost'),
  migrationDetail: document.querySelector('#migration-detail'),
  comparisonWindowLabel: document.querySelector('#comparison-window-label'),
  poolComparison: document.querySelector('#pool-comparison'),
  comparisonNote: document.querySelector('#comparison-note'),
  volumeTitle: document.querySelector('#volume-title'),
  coverageNote: document.querySelector('#coverage-note'),
  positionVerification: document.querySelector('#position-verification'),
  positions: document.querySelector('#positions'),
  portfolioBoundary: document.querySelector('#portfolio-boundary'),
  portfolioNfts: document.querySelector('#portfolio-nfts'),
  portfolioNftStatus: document.querySelector('#portfolio-nft-status'),
  portfolioPrincipal: document.querySelector('#portfolio-principal'),
  portfolioPrincipalAssets: document.querySelector('#portfolio-principal-assets'),
  portfolioLifetimeFees: document.querySelector('#portfolio-lifetime-fees'),
  portfolioFeeSplit: document.querySelector('#portfolio-fee-split'),
  portfolioGas: document.querySelector('#portfolio-gas'),
  portfolioGasUsd: document.querySelector('#portfolio-gas-usd'),
  portfolioWallet: document.querySelector('#portfolio-wallet'),
  portfolioWalletAssets: document.querySelector('#portfolio-wallet-assets'),
  portfolioCapital: document.querySelector('#portfolio-capital'),
  portfolioLineage: document.querySelector('#portfolio-lineage'),
  portfolioAudit: document.querySelector('#portfolio-audit'),
  portfolioPriceCoverage: document.querySelector('#portfolio-price-coverage'),
  portfolioPriceLedger: document.querySelector('#portfolio-price-ledger'),
  portfolioPositions: document.querySelector('#portfolio-positions'),
  portfolioReceipts: document.querySelector('#portfolio-receipts'),
  portfolioTransactions: document.querySelector('#portfolio-transactions'),
  footerUpdate: document.querySelector('#footer-update'),
  tooltip: document.querySelector('#chart-tooltip'),
}

function svg(name, attributes = {}, text = null) {
  const node = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
  if (text != null) node.textContent = text
  return node
}

function compact(value, digits = 1) {
  if (!Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 1e9) return `${(value / 1e9).toFixed(digits)}B`
  if (absolute >= 1e6) return `${(value / 1e6).toFixed(digits)}M`
  if (absolute >= 1e3) return `${(value / 1e3).toFixed(digits)}K`
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}

function tokenAmount(value) {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1000) return compact(value, 2)
  if (Math.abs(value) >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 3 })
  return value.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

function money(value, digits = 0) {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1e6) return `$${compact(value, 2)}`
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: Math.max(digits, Math.abs(value) < 100 ? 2 : 0),
  })
}

function price(value) {
  if (!Number.isFinite(value)) return '—'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 8 })}`
}

function numberOrNull(value) {
  if (value == null || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function percent(value, digits = 1, signed = false) {
  if (!Number.isFinite(value)) return '—'
  const sign = signed && value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('en-US', { maximumFractionDigits: digits })}%`
}

function localTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function shortHash(value) {
  if (!value || value.length < 14) return value || '—'
  return `${value.slice(0, 8)}…${value.slice(-6)}`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function durationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '时长 UNKNOWN'
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))} 分钟`
  if (seconds < 86_400) return `${(seconds / 3_600).toFixed(seconds < 36_000 ? 1 : 0)} 小时`
  return `${(seconds / 86_400).toFixed(seconds < 864_000 ? 1 : 0)} 天`
}

function qualityBadge(level) {
  const normalized = ['VERIFIED', 'DERIVED', 'PARTIAL', 'UNKNOWN'].includes(level) ? level : 'UNKNOWN'
  return `<span class="quality-badge quality-${normalized.toLowerCase()}">${normalized}</span>`
}

function assetSummary(amounts = {}, { includeEth = false } = {}) {
  const rows = []
  if (includeEth && Number(amounts.eth)) rows.push(`${tokenAmount(Number(amounts.eth))} ETH`)
  if (Number(amounts.spy)) rows.push(`${tokenAmount(Number(amounts.spy))} SPY`)
  if (Number(amounts.pair)) rows.push(`${tokenAmount(Number(amounts.pair))} PAIR`)
  if (Number(amounts.usdg)) rows.push(`${tokenAmount(Number(amounts.usdg))} USDG`)
  if (Number(amounts.one)) rows.push(`${tokenAmount(Number(amounts.one))} $1`)
  return rows.length ? rows.join(' · ') : '—'
}

function relativeAge(seconds) {
  if (!Number.isFinite(seconds)) return '尚无快照'
  if (seconds < 10) return '刚刚更新'
  if (seconds < 60) return `${Math.floor(seconds)} 秒前更新`
  return `${Math.floor(seconds / 60)} 分钟前更新`
}

function setStatus(runtime) {
  const normalized = runtime.status
  const className =
    normalized === 'LIVE'
      ? 'status-live'
      : normalized === 'STALE' || normalized === 'DEGRADED'
        ? 'status-stale'
        : normalized === 'ERROR'
          ? 'status-error'
          : 'status-loading'
  elements.statusPill.className = `status-pill ${className}`
  elements.statusPill.querySelector('span').textContent = normalized
  elements.freshnessLine.textContent = relativeAge(runtime.ageSeconds)
}

function linear(low, high, rangeLow, rangeHigh) {
  const span = high - low || 1
  return (value) => rangeLow + ((value - low) * (rangeHigh - rangeLow)) / span
}

function pointerTooltip(event, datum) {
  elements.tooltip.hidden = false
  elements.tooltip.innerHTML = [
    `<strong>${price(datum.priceMidUsdg)}</strong>`,
    `Tick ${datum.tickLower} – ${datum.tickUpper}`,
    `成交 ${money(datum.volumeUsdg || 0)}`,
    `全池费用估算 ${money(datum.grossFeeUsdg || 0, 2)}`,
    `市场 L ${compact(Number(datum.marketLiquidity) / 1e22, 2)} ×10²²`,
    `我方份额 ${(datum.ourSharePct || 0).toFixed(3)}%`,
  ].join('<br>')
  const left = Math.min(window.innerWidth - elements.tooltip.offsetWidth - 10, event.clientX + 13)
  const top = Math.min(window.innerHeight - elements.tooltip.offsetHeight - 10, event.clientY + 13)
  elements.tooltip.style.left = `${Math.max(8, left)}px`
  elements.tooltip.style.top = `${Math.max(8, top)}px`
}

function hideTooltip() {
  elements.tooltip.hidden = true
}

function drawChart(target, bins, options, data) {
  const node = document.querySelector(target)
  node.replaceChildren()
  if (!bins.length) return

  const width = 960
  const height = options.small ? 278 : 316
  const margin = { top: 18, right: 22, bottom: 48, left: 66 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  node.setAttribute('viewBox', `0 0 ${width} ${height}`)
  node.setAttribute('preserveAspectRatio', 'none')

  const xLow = Math.min(...bins.map((item) => item.priceLowUsdg))
  const xHigh = Math.max(...bins.map((item) => item.priceHighUsdg))
  const value = options.value
  const values = bins.map(value)
  const yMaxRaw = Math.max(...values, 0)
  const yMax = yMaxRaw > 0 ? yMaxRaw * 1.12 : 1
  const x = linear(xLow, xHigh, 0, plotWidth)
  const y = linear(0, yMax, plotHeight, 0)
  const plot = svg('g', { transform: `translate(${margin.left},${margin.top})` })
  node.append(plot)

  for (const position of data.positions.filter((item) => item.status === 'active')) {
    const left = Math.max(0, x(position.priceLowUsdg))
    const right = Math.min(plotWidth, x(position.priceHighUsdg))
    if (right > left)
      plot.append(svg('rect', { class: 'position-band', x: left, y: 0, width: right - left, height: plotHeight }))
  }
  const focusLeft = Math.max(0, x(data.focusBandUsdg.low))
  const focusRight = Math.min(plotWidth, x(data.focusBandUsdg.high))
  if (focusRight > focusLeft)
    plot.append(
      svg('rect', { class: 'focus-band', x: focusLeft, y: 0, width: focusRight - focusLeft, height: plotHeight }),
    )

  for (let index = 0; index <= 4; index += 1) {
    const numeric = (yMax * index) / 4
    const at = y(numeric)
    plot.append(svg('line', { class: 'grid', x1: 0, x2: plotWidth, y1: at, y2: at }))
    plot.append(svg('text', { class: 'axis', x: -10, y: at + 4, 'text-anchor': 'end' }, options.yFormat(numeric)))
  }
  for (let index = 0; index <= 5; index += 1) {
    const numeric = xLow + ((xHigh - xLow) * index) / 5
    const at = x(numeric)
    plot.append(
      svg(
        'text',
        {
          class: 'axis',
          x: at,
          y: plotHeight + 24,
          'text-anchor': index === 0 ? 'start' : index === 5 ? 'end' : 'middle',
        },
        `$${numeric.toFixed(4)}`,
      ),
    )
  }
  node.append(
    svg(
      'text',
      {
        class: 'axis-title',
        x: margin.left + plotWidth / 2,
        y: height - 7,
        'text-anchor': 'middle',
      },
      'PAIR / USDG',
    ),
  )

  if (options.kind === 'bar') {
    const barWidth = Math.max(2, plotWidth / bins.length - 2)
    for (const item of bins) {
      const numeric = value(item)
      plot.append(
        svg('rect', {
          x: x(item.priceMidUsdg) - barWidth / 2,
          y: y(numeric),
          width: barWidth,
          height: Math.max(0, plotHeight - y(numeric)),
          fill: options.color,
          opacity: 0.78,
        }),
      )
    }
  } else {
    const points = bins.map((item) => `${x(item.priceMidUsdg)},${y(value(item))}`).join(' ')
    if (options.area) {
      plot.append(
        svg('polygon', {
          points: `0,${plotHeight} ${points} ${plotWidth},${plotHeight}`,
          fill: options.color,
          opacity: 0.07,
        }),
      )
    }
    plot.append(
      svg('polyline', {
        points,
        fill: 'none',
        stroke: options.color,
        'stroke-width': 2.2,
        'vector-effect': 'non-scaling-stroke',
      }),
    )
    if (options.secondary) {
      const secondaryPoints = bins
        .map((item) => `${x(item.priceMidUsdg)},${y(options.secondary.value(item))}`)
        .join(' ')
      plot.append(
        svg('polyline', {
          points: secondaryPoints,
          fill: 'none',
          stroke: options.secondary.color,
          'stroke-width': 2,
          'vector-effect': 'non-scaling-stroke',
        }),
      )
    }
  }

  const currentX = x(data.pool.pairUsdg)
  if (currentX >= 0 && currentX <= plotWidth) {
    plot.append(svg('line', { class: 'current-line', x1: currentX, x2: currentX, y1: 0, y2: plotHeight }))
    plot.append(svg('text', { class: 'current-label', x: currentX + 6, y: 11 }, 'NOW'))
  }

  const hitWidth = plotWidth / bins.length
  for (const item of bins) {
    const hit = svg('rect', {
      class: 'hit',
      x: x(item.priceMidUsdg) - hitWidth / 2,
      y: 0,
      width: Math.max(4, hitWidth),
      height: plotHeight,
    })
    hit.addEventListener('pointermove', (event) => pointerTooltip(event, item))
    hit.addEventListener('pointerleave', hideTooltip)
    plot.append(hit)
  }
}

function drawTrendModel(data) {
  const node = elements.trendChart
  const model = data.trendModel
  const selection = model?.rangeSelection
  const selected = selection?.selected
  const nextTarget = selection?.nextTarget
  node.replaceChildren()
  if (!model || !selected) return

  const width = 960
  const height = 318
  const margin = { top: 16, right: 22, bottom: 40, left: 24 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const volumeTop = 158
  const volumeBottom = 244
  const bins = (data.analytics?.bins || []).filter(
    (bin) => Number(bin.volumeUsdg) > 0 && Number.isFinite(Number(bin.priceMidUsdg)),
  )
  const activeRanges = (model.activeRanges || []).filter(
    (range) => Number.isFinite(range.priceLowUsdg) && Number.isFinite(range.priceHighUsdg),
  )
  const prices = [
    data.pool.pairUsdg,
    selected.priceLowUsdg,
    selected.priceHighUsdg,
    nextTarget?.priceLowUsdg,
    nextTarget?.priceHighUsdg,
    selection.hotBand6hUsdg?.p10,
    selection.hotBand6hUsdg?.p90,
    ...bins.flatMap((bin) => [bin.priceLowUsdg, bin.priceHighUsdg]),
    ...activeRanges.flatMap((range) => [range.priceLowUsdg, range.priceHighUsdg]),
  ].filter(Number.isFinite)
  if (!prices.length) return
  const rawLow = Math.min(...prices)
  const rawHigh = Math.max(...prices)
  const padding = Math.max((rawHigh - rawLow) * 0.035, 0.0001)
  const xLow = Math.max(0, rawLow - padding)
  const xHigh = rawHigh + padding
  const x = linear(xLow, xHigh, 0, plotWidth)
  const maxVolume = Math.max(...bins.map((bin) => Number(bin.volumeUsdg)), 1)

  node.setAttribute('viewBox', `0 0 ${width} ${height}`)
  node.setAttribute('preserveAspectRatio', 'none')
  const plot = svg('g', { transform: `translate(${margin.left},${margin.top})` })
  node.append(plot)

  for (let index = 0; index <= 5; index += 1) {
    const value = xLow + ((xHigh - xLow) * index) / 5
    const at = x(value)
    plot.append(svg('line', { class: 'trend-grid-line', x1: at, x2: at, y1: 0, y2: plotHeight }))
    plot.append(
      svg(
        'text',
        {
          class: 'trend-axis-label',
          x: at,
          y: plotHeight + 25,
          'text-anchor': index === 0 ? 'start' : index === 5 ? 'end' : 'middle',
        },
        `$${value.toFixed(value < 0.1 ? 4 : 3)}`,
      ),
    )
  }

  const hotLow = selection.hotBand6hUsdg?.p10
  const hotHigh = selection.hotBand6hUsdg?.p90
  if (Number.isFinite(hotLow) && Number.isFinite(hotHigh)) {
    plot.append(
      svg('rect', {
        class: 'trend-hot-zone',
        x: x(Math.min(hotLow, hotHigh)),
        y: volumeTop,
        width: Math.max(1, x(Math.max(hotLow, hotHigh)) - x(Math.min(hotLow, hotHigh))),
        height: volumeBottom - volumeTop,
      }),
    )
  }

  const targetLeft = x(selected.priceLowUsdg)
  const targetRight = x(selected.priceHighUsdg)
  plot.append(
    svg('rect', {
      class: 'trend-target-zone',
      x: targetLeft,
      y: 19,
      width: Math.max(1, targetRight - targetLeft),
      height: volumeBottom - 19,
    }),
  )
  if (nextTarget) {
    const nextLeft = x(nextTarget.priceLowUsdg)
    const nextRight = x(nextTarget.priceHighUsdg)
    plot.append(
      svg('rect', {
        class: 'trend-next-zone',
        x: nextLeft,
        y: 27,
        width: Math.max(1, nextRight - nextLeft),
        height: volumeBottom - 27,
      }),
    )
  }
  plot.append(
    svg(
      'text',
      { class: 'trend-target-label', x: targetLeft + 6, y: 34 },
      `${selection.activeTarget ? 'TARGET' : 'LEADING · NO TRADE'} · $${selected.actualPriceWidthUsdg.toFixed(4)}`,
    ),
  )

  const activeRows = activeRanges.slice(0, 8)
  for (const [index, range] of activeRows.entries()) {
    const low = Math.max(xLow, range.priceLowUsdg)
    const high = Math.min(xHigh, range.priceHighUsdg)
    if (high <= low) continue
    const y = 52 + index * 11
    plot.append(svg('line', { class: 'trend-active-line', x1: x(low), x2: x(high), y1: y, y2: y }))
  }

  const barWidth = Math.max(2, plotWidth / Math.max(bins.length, 1) - 1)
  for (const bin of bins) {
    const barHeight = (Number(bin.volumeUsdg) / maxVolume) * (volumeBottom - volumeTop)
    plot.append(
      svg('rect', {
        class: 'trend-volume-bar',
        x: x(Number(bin.priceMidUsdg)) - barWidth / 2,
        y: volumeBottom - barHeight,
        width: barWidth,
        height: barHeight,
      }),
    )
  }

  const now = x(data.pool.pairUsdg)
  plot.append(svg('line', { class: 'trend-now-line', x1: now, x2: now, y1: 0, y2: volumeBottom }))
  plot.append(svg('text', { class: 'trend-now-label', x: now + 5, y: 11 }, 'NOW'))
}

function renderExternalStrategy(data) {
  const strategy = data.strategies?.[0]
  if (!strategy) {
    elements.strategyEvidence.textContent = 'CHAIN · UNAVAILABLE'
    elements.strategyEvidence.className = 'boundary-pill boundary-partial'
    elements.strategyNote.textContent = '当前快照没有外部策略账户；主面板仍可独立工作。'
    elements.strategyPositions.replaceChildren()
    return
  }

  const verified = strategy.status === 'VERIFIED'
  const totals = strategy.totals || {}
  const lifecycle = strategy.lifecycleSummary || {}
  elements.strategyEvidence.textContent = `CHAIN · ${strategy.status}`
  elements.strategyEvidence.className = `boundary-pill boundary-${verified ? 'verified' : 'partial'}`
  elements.strategyWallet.textContent = `${strategy.label} · ${shortHash(strategy.wallet)}`
  elements.strategyPrice.textContent = price(strategy.pool?.pairUsdg)
  const strategyTick = numberOrNull(strategy.pool?.currentTick)
  elements.strategyBlock.textContent = `SAFE #${Number(strategy.asOfBlock).toLocaleString('en-US')} · Tick ${
    strategyTick == null ? '—' : strategyTick.toLocaleString('en-US')
  }`
  elements.strategyPrincipal.textContent = money(totals.principalUsdg, 2)
  elements.strategyAssets.textContent = `USDG ${tokenAmount(totals.principalUsdgToken)} · PAIR ${tokenAmount(
    totals.principalPair,
  )}`
  elements.strategyFees.textContent = money(totals.accruedFeesUsdg, 2)
  elements.strategyFeeAssets.textContent = `USDG ${tokenAmount(totals.accruedFeeUsdgToken)} · PAIR ${tokenAmount(
    totals.accruedFeePair,
  )}`
  elements.strategyPositionCount.textContent = `${lifecycle.active ?? 0} / ${strategy.expectedActivePositions}`
  elements.strategyPositionStatus.textContent = `${lifecycle.inRange ?? 0} 档成交中 · ${
    strategy.inventory?.indexedOwnedCount ?? '—'
  }/${strategy.inventory?.expectedBalance ?? '—'} NFT 对账`
  elements.strategyIdle.textContent = money(totals.idleUsdgValue, 2)
  elements.strategyGas.textContent = `USDG ${tokenAmount(totals.walletBalances?.usdg)} · PAIR ${tokenAmount(
    totals.walletBalances?.pair,
  )} · Gas ${tokenAmount(totals.walletBalances?.eth)} ETH`

  elements.strategyPositions.replaceChildren()
  for (const position of strategy.positions || []) {
    const currentPrice = Number(strategy.pool?.pairUsdg)
    const rangeState = position.inRange
      ? '成交中'
      : currentPrice > Number(position.priceHighUsdg)
        ? 'BUY 等待 · USDG'
        : currentPrice < Number(position.priceLowUsdg)
          ? 'SELL 等待 · PAIR'
          : '场外'
    const row = document.createElement('article')
    row.className = `strategy-row ${position.inRange ? 'is-in-range' : ''}`
    row.setAttribute('role', 'row')
    row.innerHTML = `
      <div class="strategy-position-id" role="cell">
        <strong>${position.bandLabel}</strong>
        <small>NFT #${position.tokenId}</small>
      </div>
      <div class="strategy-cell" role="cell">
        <strong>${price(position.priceLowUsdg)} → ${price(position.priceHighUsdg)}</strong>
        <small>Tick ${Number(position.tickLower).toLocaleString('en-US')} → ${Number(position.tickUpper).toLocaleString(
          'en-US',
        )}</small>
      </div>
      <div class="strategy-cell" role="cell">
        <strong>${rangeState}</strong>
        <small>${escapeHtml(position.dataQuality === 'verified' ? '同安全区块核验' : position.dataQuality)}</small>
      </div>
      <div class="strategy-cell" role="cell">
        <strong>${money(position.principal?.usdg, 2)}</strong>
        <small>${tokenAmount(position.principal?.usdgToken)} USDG · ${tokenAmount(position.principal?.pair)} PAIR</small>
      </div>
      <div class="strategy-cell" role="cell">
        <strong>${money(position.accruedFees?.usdg, 2)}</strong>
        <small>${tokenAmount(position.accruedFees?.usdgToken)} USDG · ${tokenAmount(position.accruedFees?.pair)} PAIR</small>
      </div>
    `
    elements.strategyPositions.append(row)
  }

  const warningText = strategy.warnings?.length
    ? `告警：${strategy.warnings.join(' · ')}。`
    : 'NFT 数量与逐仓读回一致。'
  elements.strategyNote.textContent = `${warningText} 成本基础未并入公开总账；Keeper 运行健康由私有监控独立验证。`
}

function renderTrendModel(data) {
  const model = data.trendModel
  const selection = model?.rangeSelection
  const selected = selection?.selected
  const evidence = model?.evidenceLevel || 'PARTIAL'
  elements.trendEvidence.textContent = `MODEL · ${evidence}`
  elements.trendEvidence.className = `boundary-pill boundary-${evidence === 'MODELLED' ? 'verified' : 'partial'}`
  const signalView = {
    BUILDING_EVIDENCE: ['积累证据', '成交窗口或流动性复核尚未满足完整模型条件。'],
    RESCAN_NO_TRADE: ['暂无合格区间', '候选没有同时通过宽度、成交覆盖和市场份额门槛；继续观察，不生成动作。'],
    UPTREND_READY: ['上行候选成立', '成交加速与 PAIR 主动买入占比同时越过阈值；仍只展示，不执行。'],
    HOLD_RANGE: ['维持观察', '当前没有同时满足成交加速与买入方向门槛。'],
  }[model?.signal] || ['等待模型', '尚无可用的安全区块模型结果。']
  elements.trendSignal.textContent = signalView[0]
  elements.trendCopy.textContent = signalView[1]
  elements.trendTarget.textContent = selected
    ? `${selection.activeTarget ? '合格目标' : '领先候选（不交易）'} · ${price(selected.priceLowUsdg)} → ${price(selected.priceHighUsdg)}`
    : '—'
  elements.trendWidth.textContent = selected
    ? `$${selected.actualPriceWidthUsdg.toFixed(5)} / ${percent(selected.targetWidthDeviationPct, 1)}`
    : '—'
  const hot = selection?.hotBand6hUsdg
  elements.trendHotBand.textContent =
    Number.isFinite(hot?.p10) && Number.isFinite(hot?.p90) ? `${price(hot.p10)} → ${price(hot.p90)}` : '—'
  const flow = model?.flowSignals
  elements.trendFlow.textContent = flow?.dataComplete
    ? `${flow.volumeMultiple.toFixed(2)}× / ${percent(flow.oneHourPairBuySharePct, 1)}`
    : 'PARTIAL'
  elements.trendCandidates.replaceChildren()
  for (const [index, candidate] of (selection?.candidates || []).slice(0, 3).entries()) {
    const row = document.createElement('div')
    const isSelected = candidate.tickLower === selected?.tickLower && candidate.tickUpper === selected?.tickUpper
    const anchors = candidate.anchorSources || ['legacy_candidate']
    const rejectionReasons = candidate.rejectionReasons || ['NOT_QUALIFIED']
    const volumeAnchored = anchors.some((source) => source.includes('volume'))
    const qualification = candidate.qualified ? 'PASS' : `FAIL · ${rejectionReasons[0]}`
    row.className = `trend-candidate ${isSelected ? 'is-selected' : ''}`
    row.title = candidate.qualified
      ? `资格门槛全部通过；锚点：${anchors.join(', ')}`
      : `未通过：${rejectionReasons.join(', ')}；锚点：${anchors.join(', ')}`
    row.innerHTML = `
      <b>${String(index + 1).padStart(2, '0')}</b>
      <strong>${price(candidate.priceLowUsdg)} → ${price(candidate.priceHighUsdg)}</strong>
      <span>${percent(candidate.oneHour.coveragePct, 0)} HOT · ${percent(candidate.oneHour.modeledVolumeWeightedSharePct, 2)} SHARE · ${volumeAnchored ? 'VOL' : 'SPOT'} · ${qualification}</span>
    `
    elements.trendCandidates.append(row)
  }
  drawTrendModel(data)
}

function renderPositions(data) {
  elements.positions.replaceChildren()
  for (const item of [...data.positions, ...(data.directPositions || [])]) {
    const card = document.createElement('article')
    const isActive = item.status === 'active'
    const isDirect = item.poolKind === 'direct'
    card.className = `position-card ${item.inRange ? 'in-range' : 'out-range'}`
    const status = !isActive ? item.status.toUpperCase() : item.inRange ? 'IN RANGE' : 'OUT OF RANGE'
    card.innerHTML = `
      <header>
        <div><h3>${item.label}</h3><span class="token-id">NFT #${item.tokenId}</span></div>
        <span class="range-status ${item.inRange ? 'in' : 'out'}">${status}</span>
      </header>
      <p class="position-range">${price(item.priceLowUsdg)}<br>→ ${price(item.priceHighUsdg)}</p>
      <div class="position-stats">
        <div><p>仓位现值</p><strong>${money(item.principal?.usdg || 0)}</strong></div>
        <div><p>未领取费用</p><strong>${money(item.accruedFees?.usdg || 0, 2)}</strong></div>
        <div><p>${isDirect ? 'USDG 本金' : 'SPY 本金'}</p><strong>${tokenAmount(isDirect ? item.principal?.usdgToken || 0 : item.principal?.spy || 0)}</strong></div>
        <div><p>PAIR 本金</p><strong>${tokenAmount(item.principal?.pair || 0)}</strong></div>
      </div>
    `
    elements.positions.append(card)
  }
}

function statusLabel(status) {
  const labels = {
    active: 'ACTIVE',
    empty: 'EMPTY',
    owner_mismatch: 'OWNER CHANGED',
    read_failed: 'READ FAILED',
    unknown: 'UNKNOWN',
  }
  return labels[status] || String(status || 'UNKNOWN').toUpperCase()
}

function renderPriceLedger(portfolio, visiblePositions) {
  const coverage = portfolio.accountingBoundary?.historicalPriceLedger || {}
  const total = Number(coverage.total || portfolio.positions.length)
  elements.portfolioPriceCoverage.textContent = [
    `${coverage.entryMarket || 0}/${total} 入场市价`,
    `${coverage.holdingTwap || 0}/${total} 持仓 TWAP`,
    `${coverage.implicitExecution || 0}/${total} LP 净成交`,
    `${coverage.closedExitAssets || 0}/${portfolio.totals.emptyNfts} 已撤仓资产`,
  ].join(' · ')
  elements.portfolioPriceLedger.replaceChildren()

  const inventoryLabels = {
    current_principal_same_safe_block: '安全区块当前本金',
    exit_principal_fees_separated: '退出本金已拆费',
    exit_gross_includes_unallocated_fees: '退出总额含未拆费用',
    exit_assets_unknown: '退出资产缺失',
  }

  for (const position of visiblePositions) {
    const ledger = position.priceLedger || {}
    const entry = ledger.entry || {}
    const holding = ledger.holding || {}
    const endpoint = ledger.endpoint || {}
    const execution = ledger.implicitExecution || {}
    const result = ledger.markedResult || {}
    const accounting = position.accounting || {}
    const isPairPosition = ['pair-spy', 'pair-usdg'].includes(position.poolKind)

    const entryValue = numberOrNull(entry.pairUsdg)
    const entryCell = Number.isFinite(entryValue)
      ? `<strong>${price(entryValue)}</strong><small>${entry.markedEvents}/${entry.totalEvents} 次加入有历史标价 · ${qualityBadge(entry.quality)}</small>`
      : `<strong>${isPairPosition ? '价格待补' : '非 PAIR 仓'}</strong><small>${qualityBadge(entry.quality)} · ${entry.totalEvents || 0} 次加入</small>`

    const holdingValue = numberOrNull(holding.pairUsdg)
    const holdingCell = Number.isFinite(holdingValue)
      ? `<strong>${price(holdingValue)}</strong><small>覆盖 ${percent(numberOrNull(holding.coveragePct), 1)} · ${durationLabel(numberOrNull(ledger.holdingSeconds))} · ${qualityBadge(holding.quality)}</small>`
      : `<strong>${isPairPosition ? 'TWAP 待补' : '不适用'}</strong><small>${durationLabel(numberOrNull(ledger.holdingSeconds))} · ${qualityBadge(holding.quality)}</small>`

    const endpointValue = numberOrNull(endpoint.pairUsdg)
    const endpointLabel = endpoint.kind === 'EXIT' ? '退出时' : '当前'
    const endpointCell = Number.isFinite(endpointValue)
      ? `<strong>${price(endpointValue)}</strong><small>${endpointLabel} ${localTime(endpoint.at)} · ${qualityBadge(endpoint.quality)}</small>`
      : `<strong>${isPairPosition ? `${endpointLabel}价格待补` : '不适用'}</strong><small>${localTime(endpoint.at)} · ${qualityBadge(endpoint.quality)}</small>`

    const executionValue = numberOrNull(execution.pairUsdg)
    let executionCell
    if (Number.isFinite(executionValue)) {
      const sideClass = execution.side === 'BUY' ? 'trade-buy' : 'trade-sell'
      executionCell = `<strong class="${sideClass}">${execution.side} ${price(executionValue)}</strong><small>ΔPAIR ${execution.pairDelta > 0 ? '+' : ''}${tokenAmount(Number(execution.pairDelta))} · ${qualityBadge(execution.quality)}</small>`
    } else if (execution.side === 'NONE') {
      executionCell = `<strong>无净转换</strong><small>两侧数量未形成可比成交 · ${qualityBadge(execution.quality)}</small>`
    } else {
      executionCell = `<strong>${isPairPosition ? '成交价待补' : '不适用'}</strong><small>${qualityBadge(execution.quality)}</small>`
    }

    const feeAdjusted = numberOrNull(execution.feeAdjustedPairUsdg)
    const markedPnl = numberOrNull(result.pnlUsdg)
    let resultCell
    if (position.status === 'active') {
      const breakEven = numberOrNull(accounting.pairBreakEvenAfterFeesUsdg)
      const versusHodl = numberOrNull(accounting.versusSuppliedHodlUsdg)
      resultCell = Number.isFinite(breakEven)
        ? breakEven <= 0
          ? `<strong>成本已覆盖</strong><small>非 PAIR 本金 + 已记录手续费已覆盖入场成本${Number.isFinite(versusHodl) ? ` · vs 原币 ${money(versusHodl, 2)}` : ''}</small>`
          : `<strong>${price(breakEven)}</strong><small>PAIR 手续费后回本${Number.isFinite(versusHodl) ? ` · vs 原币 ${money(versusHodl, 2)}` : ''}</small>`
        : `<strong>回本价待补</strong><small>当前仓仍按安全区块追踪</small>`
    } else if (Number.isFinite(markedPnl)) {
      resultCell = `<strong class="${markedPnl >= 0 ? 'positive' : 'negative'}">${money(markedPnl, 2)}</strong><small>退出时 NFT 局部结果 ${percent(numberOrNull(result.pnlPct), 2, true)} · ${qualityBadge(result.quality)}${Number.isFinite(feeAdjusted) ? `<br>费用后 ${execution.side} ${price(feeAdjusted)} · ${qualityBadge(execution.feeAdjustedQuality)}` : ''}</small>`
    } else if (Number.isFinite(feeAdjusted)) {
      resultCell = `<strong>${price(feeAdjusted)}</strong><small>记录费用后 ${execution.side} · ${qualityBadge(execution.feeAdjustedQuality)}</small>`
    } else {
      resultCell = `<strong>结果未闭合</strong><small>不以现价冒充历史成本</small>`
    }

    const row = document.createElement('article')
    row.className = `price-ledger-row status-${position.status}`
    row.setAttribute('role', 'row')
    row.innerHTML = `
      <div class="price-ledger-identity" role="cell">
        <i></i>
        <div><strong>${position.label}</strong><small>#${position.tokenId} · ${position.poolLabel}</small></div>
      </div>
      <div class="price-ledger-cell" role="cell">${entryCell}</div>
      <div class="price-ledger-cell" role="cell">${holdingCell}</div>
      <div class="price-ledger-cell" role="cell">${endpointCell}</div>
      <div class="price-ledger-cell" role="cell">${executionCell}</div>
      <div class="price-ledger-cell price-ledger-result" role="cell">${resultCell}</div>
      <div class="price-ledger-cell price-ledger-evidence" role="cell">
        ${qualityBadge(ledger.overallQuality)}
        <small>${inventoryLabels[ledger.inventory?.source] || '证据路径待核对'}</small>
      </div>
    `
    elements.portfolioPriceLedger.append(row)
  }
}

function renderPortfolio(data) {
  const portfolio = data.portfolio
  if (!portfolio) return
  const totals = portfolio.totals
  elements.portfolioBoundary.textContent = `CAPITAL · ${portfolio.accountingBoundary.aggregateCashInvested}`
  elements.portfolioBoundary.className = `boundary-pill boundary-${portfolio.accountingBoundary.aggregateCashInvested.toLowerCase()}`
  elements.portfolioNfts.textContent = totals.lifecycleNfts.toLocaleString('en-US')
  elements.portfolioNftStatus.textContent = `${totals.activeNfts} 活跃 · ${totals.emptyNfts} 已撤空 · ${totals.exceptionNfts} 异常`
  elements.portfolioPrincipal.textContent = money(totals.activePrincipalUsdg, 2)
  elements.portfolioPrincipalAssets.textContent = assetSummary(totals.activePrincipal)
  elements.portfolioLifetimeFees.textContent = money(totals.recordedLifetimeFeesCurrentMarkUsdg, 2)
  elements.portfolioFeeSplit.textContent = `已领 ${money(totals.recordedClaimedFeesCurrentMarkUsdg, 2)} · 未领 ${money(totals.unclaimedFeesUsdg, 2)}`
  elements.portfolioGas.textContent = `${totals.gasEth.toFixed(5)} ETH`
  elements.portfolioGasUsd.textContent =
    totals.gasUsdgCurrentMark == null
      ? `${totals.confirmedReceipts} 成功 · ${totals.revertedReceipts} 回滚`
      : `${money(totals.gasUsdgCurrentMark, 2)} 当前换算 · ${totals.revertedReceipts} 回滚`
  elements.portfolioWallet.textContent = money(totals.walletBalancesUsdg, 2)
  elements.portfolioWalletAssets.textContent = assetSummary(totals.walletBalances, { includeEth: true })
  elements.portfolioCapital.textContent = `${totals.lpDirectedEthObserved.toFixed(4)} ETH`

  const byId = new Map(portfolio.positions.map((position) => [String(position.tokenId), position]))
  elements.portfolioLineage.replaceChildren()
  for (const edge of portfolio.lineages) {
    const row = document.createElement('div')
    const from = byId.get(String(edge.from))
    const to = byId.get(String(edge.to))
    row.className = `lineage-row lineage-${edge.type}`
    row.innerHTML = `
      <span class="lineage-node"><b>${from?.label || edge.from}</b><small>#${edge.from}</small></span>
      <span class="lineage-arrow"><i></i><em>${edge.type.replaceAll('_', ' ')}</em></span>
      <span class="lineage-node"><b>${to?.label || edge.to}</b><small>#${edge.to}</small></span>
    `
    row.title = edge.label
    elements.portfolioLineage.append(row)
  }

  const auditRows = [
    {
      label: 'NFT 清单',
      value:
        portfolio.audit?.expectedBalance == null
          ? `${portfolio.audit?.chainIds?.length || 0}/${portfolio.audit?.localIds?.length || 0}`
          : `${portfolio.audit.inferredOwnedNfts}/${portfolio.audit.expectedBalance}`,
      detail: `${portfolio.audit?.inventoryStatus || 'UNKNOWN'} · 自动 Transfer 游标`,
      level: portfolio.accountingBoundary.chainInventory.startsWith('verified') ? 'verified' : 'partial',
    },
    {
      label: '交易回执',
      value: `${totals.confirmedReceipts + totals.revertedReceipts}`,
      detail: `${totals.confirmedReceipts} SUCCESS · ${totals.revertedReceipts} REVERTED`,
      level: 'verified',
    },
    {
      label: '活跃仓估值',
      value: portfolio.accountingBoundary.activeValuation.toUpperCase(),
      detail: `同一安全区块 #${Number(portfolio.asOfBlock).toLocaleString('en-US')}`,
      level: portfolio.accountingBoundary.activeValuation,
    },
    {
      label: '累计手续费',
      value: 'PARTIAL',
      detail: '已记录领取 + 当前未领取；部分撤仓内含费用无法拆分',
      level: 'partial',
    },
    {
      label: '历史价格账本',
      value: `${portfolio.accountingBoundary.historicalPriceLedger?.holdingTwap || 0}/${totals.lifecycleNfts}`,
      detail: `${portfolio.accountingBoundary.historicalPriceLedger?.closedExitAssets || 0}/${totals.emptyNfts} 个已撤仓资产可追溯`,
      level: (portfolio.accountingBoundary.historicalPriceLedger?.holdingTwap || 0) > 0 ? 'verified' : 'partial',
    },
    {
      label: '外部总投入',
      value: 'PARTIAL',
      detail: '原生 ETH 外部转入与既有代币批次尚未完全归因',
      level: 'partial',
    },
  ]
  elements.portfolioAudit.replaceChildren()
  for (const item of auditRows) {
    const row = document.createElement('div')
    row.className = `audit-row audit-${item.level}`
    row.innerHTML = `<span>${item.label}</span><strong>${item.value}</strong><small>${item.detail}</small>`
    elements.portfolioAudit.append(row)
  }

  const visible = portfolio.positions.filter(
    (position) => state.portfolioFilter === 'all' || position.status === state.portfolioFilter,
  )
  renderPriceLedger(portfolio, visible)
  elements.portfolioPositions.replaceChildren()
  for (const position of visible) {
    const row = document.createElement('article')
    const accounting = position.accounting
    const range = position.currentRange || {}
    const lifecycleEnd = position.exit?.at
      ? localTime(position.exit.at)
      : position.status === 'active'
        ? '至今'
        : '撤出时间 UNKNOWN'
    const localDelta = accounting.versusSuppliedHodlUsdg
    const localResult = Number.isFinite(localDelta)
      ? `<strong class="${localDelta >= 0 ? 'positive' : 'negative'}">${money(localDelta, 2)}</strong><small>vs 原币 ${percent(accounting.versusSuppliedHodlPct, 2, true)}</small>`
      : position.status === 'empty'
        ? `<strong>已撤空</strong><small>退出资产按血缘继续追踪</small>`
        : `<strong>口径未闭合</strong><small>禁止跨 NFT 汇总</small>`
    const breakEven = accounting.pairBreakEvenAfterFeesUsdg
    const pairBasis = accounting.impliedPairBuyPriceUsdg
    const basisLine =
      position.status === 'empty'
        ? position.exit?.transactionHash
          ? '退出已核验 · 去向见资金血缘'
          : '退出交易 UNKNOWN · 仅证实流动性为 0'
        : Number.isFinite(breakEven)
          ? breakEven <= 0
            ? 'PAIR 成本已由非 PAIR 本金与手续费覆盖'
            : `PAIR 回本 ${price(breakEven)}`
          : Number.isFinite(pairBasis)
            ? `区间内隐含买入 ${price(pairBasis)}`
            : 'PAIR 成本口径不闭合'
    row.className = `portfolio-row status-${position.status}`
    row.setAttribute('role', 'row')
    row.innerHTML = `
      <div class="portfolio-position-id" role="cell">
        <i></i>
        <div><strong>${position.label}</strong><small>#${position.tokenId} · ${position.poolLabel}</small></div>
        <span>${statusLabel(position.status)}</span>
      </div>
      <div class="portfolio-cell" role="cell">
        <strong>${localTime(position.mint?.at)} → ${lifecycleEnd}</strong>
        <small>${position.supplyEvents.length} 次加入 · ${position.claims.length} 次费用记录</small>
      </div>
      <div class="portfolio-cell" role="cell">
        <strong>${price(Number(range.low))} – ${price(Number(range.high))}</strong>
        <small>Tick ${position.tickLower.toLocaleString('en-US')} → ${position.tickUpper.toLocaleString('en-US')}</small>
      </div>
      <div class="portfolio-cell" role="cell">
        <strong>${money(accounting.currentPrincipalUsdg, 2)} / ${money(accounting.currentUnclaimedUsdg, 2)}</strong>
        <small>${assetSummary(position.principal)}</small>
      </div>
      <div class="portfolio-cell" role="cell">
        <strong>${money(accounting.claimedCurrentMarkUsdg, 2)}</strong>
        <small>按现价重估 · 非闲置余额</small>
      </div>
      <div class="portfolio-cell portfolio-local-result" role="cell">
        ${localResult}
        <small>${basisLine}</small>
      </div>
    `
    elements.portfolioPositions.append(row)
  }

  document.querySelectorAll('[data-portfolio-filter]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.portfolioFilter === state.portfolioFilter))
  })

  elements.portfolioReceipts.textContent = `${totals.confirmedReceipts} 成功 · ${totals.revertedReceipts} 回滚 · 按交易哈希去重`
  elements.portfolioTransactions.replaceChildren()
  for (const transaction of [...portfolio.transactions].reverse()) {
    const row = document.createElement('article')
    const explorer = portfolio.explorerTxBaseUrl ? `${portfolio.explorerTxBaseUrl}${transaction.hash}` : null
    const gasEth = Number(transaction.gasCostWei || 0) / 1e18
    row.className = `transaction-row tx-${transaction.status}`
    row.innerHTML = `
      <div><strong>${localTime(transaction.at)}</strong><small>Block ${Number(transaction.blockNumber).toLocaleString('en-US')}</small></div>
      <div><strong>${transaction.label}</strong><small>${transaction.action.replaceAll('_', ' ')}</small></div>
      <div><span>${transaction.status.toUpperCase()}</span></div>
      <div><strong>${gasEth < 0.0001 ? '<0.00010' : gasEth.toFixed(5)} ETH</strong></div>
      <div>${explorer ? `<a href="${explorer}" target="_blank" rel="noreferrer">${shortHash(transaction.hash)} ↗</a>` : shortHash(transaction.hash)}</div>
    `
    elements.portfolioTransactions.append(row)
  }
}

function renderComparison(data) {
  const comparison = data.comparison
  if (!comparison) return
  const baseline = comparison.rows.find((row) => row.kind === 'current')
  const selectedMetric = baseline?.windows?.[data.selectedWindow]
  elements.comparisonMethod.textContent = `安全区块 #${Number(comparison.asOfBlock).toLocaleString('en-US')} · 对照本金 ${money(comparison.capitalUsdg, 2)}`
  elements.comparisonWindowLabel.textContent = `${selectedMetric?.label || data.selectedWindow}成交`
  elements.poolComparison.replaceChildren()

  for (const row of comparison.rows) {
    const metric = row.windows[data.selectedWindow]
    if (!metric) continue
    const article = document.createElement('article')
    const leadClass = metric.relativeLeadPct > 0 ? 'positive' : metric.relativeLeadPct < 0 ? 'negative' : ''
    article.className = `comparison-row ${row.kind === 'current' ? 'is-current' : ''}`
    article.setAttribute('role', 'row')
    article.innerHTML = `
      <div class="pool-identity" role="cell">
        <span class="pool-marker"></span>
        <div>
          <strong>${row.label}</strong>
          <p>${row.feeLabel} fee · ${row.kind === 'current' ? '当前实仓' : row.actualTotals?.activePositions ? `实仓 ${row.actualTotals.activePositions} 个 · 对照模型` : '候选模拟仓'}</p>
        </div>
        <span class="coverage-tag ${metric.partialBeforeAnchor ? 'partial' : 'complete'}">${metric.partialBeforeAnchor ? 'PARTIAL' : 'FULL'}</span>
      </div>
      <div class="comparison-cell" role="cell">
        <strong>${money(metric.volumeUsdg)}</strong>
        <span>${metric.swapEvents.toLocaleString('en-US')} swaps</span>
      </div>
      <div class="comparison-cell" role="cell">
        <strong>${money(metric.estimatedFeeUsdg, 2)}</strong>
        <span>${money(metric.hourlyFeeUsdg, 2)} / h</span>
      </div>
      <div class="comparison-cell" role="cell">
        <strong>${percent(metric.dailyRatePct, 2)}</strong>
        <span>窗口毛费率年化 ${percent(metric.annualizedGrossPct, 0)}</span>
      </div>
      <div class="comparison-cell comparison-lead ${leadClass}" role="cell">
        <strong>${row.kind === 'current' ? 'BASE' : percent(metric.relativeLeadPct, 1, true)}</strong>
        <span>${row.activeRangeCount} 个映射区间生效</span>
      </div>
    `
    elements.poolComparison.append(article)
  }

  const decision = comparison.decision
  const best = decision.bestCandidate
  const copyBySignal = {
    BUILDING_EVIDENCE: {
      className: 'decision-building',
      title: '继续积累证据',
      copy: '至少一个确认窗口尚未完整，主 LP 保持不动。',
    },
    HOLD_SPY: {
      className: 'decision-hold',
      title: '保持 SPY / PAIR',
      copy: '候选池尚未同时通过持续领先与成本回收门槛。',
    },
    TEST_ELIGIBLE: {
      className: 'decision-ready',
      title: `允许 ${comparison.policy.testCapitalPct}% 小仓测试`,
      copy: `${best?.label || '候选池'} 已通过数据门槛；仍需单独做交易预检后才能执行。`,
    },
  }
  const view = copyBySignal[decision.signal] || copyBySignal.BUILDING_EVIDENCE
  elements.decisionPanel.className = `decision-panel ${view.className}`
  elements.decisionTitle.textContent = view.title
  elements.decisionCopy.textContent = view.copy
  elements.decisionGates.replaceChildren()
  for (const gate of best?.gates || []) {
    const item = document.createElement('span')
    const stateClass = !gate.coverageComplete ? 'gate-wait' : gate.pass ? 'gate-pass' : 'gate-fail'
    item.className = `decision-gate ${stateClass}`
    item.textContent = `${gate.label} ${gate.leadPct == null ? '等待' : percent(gate.leadPct, 0, true)}`
    elements.decisionGates.append(item)
  }
  if (best) {
    const costGate = document.createElement('span')
    costGate.className = `decision-gate ${best.breakEvenHours == null ? 'gate-wait' : best.costPass ? 'gate-pass' : 'gate-fail'}`
    costGate.textContent = `回本 ${best.breakEvenHours == null ? '待定' : `${best.breakEvenHours.toFixed(1)}h`}`
    elements.decisionGates.append(costGate)
  }

  const migration = comparison.migrationEstimate
  elements.migrationCost.textContent = migration.totalUsdg == null ? 'UNKNOWN' : money(migration.totalUsdg, 2)
  elements.migrationDetail.textContent =
    migration.totalUsdg == null
      ? 'ETH 报价不可用 · 必须交易前预检'
      : `Gas ${money(migration.gasCostUsdg, 2)} + 路由缓冲 ${money(migration.swapFrictionUsdg, 2)}`
  elements.comparisonNote.textContent = `${selectedMetric?.label || data.selectedWindow}短窗外推；候选池按当前流动性与我们现有美元区间静态映射。不是交易模拟，也未计无常损失与资产机会成本。`
}

function render(data) {
  state.data = data
  setStatus(data.runtime)
  elements.blockLine.textContent = `BLOCK ${Number(data.pool.blockNumber).toLocaleString('en-US')} · ${localTime(data.pool.blockTime)}`
  elements.pairPrice.textContent = price(data.pool.pairUsdg)
  elements.pairTick.textContent = `SPY ${money(data.pool.spyUsdg)} · Tick ${data.pool.currentTick.toLocaleString('en-US')}`
  elements.activeShare.textContent = `${data.pool.ourActiveSharePct.toFixed(3)}%`
  const inRange = data.positions.filter((item) => item.status === 'active' && item.inRange).length
  const directPositions = (data.directPositions || []).filter((item) => item.status === 'active')
  const directInRange = directPositions.filter((item) => item.inRange).length
  elements.activeLps.textContent = directPositions.length
    ? `SPY ${inRange}/${data.totals.activePositions} · USDG ${directInRange}/${directPositions.length}`
    : `${inRange} / ${data.totals.activePositions} 个区间生效`
  const directFees = directPositions.reduce(
    (total, item) => ({
      value: total.value + (item.accruedFees?.usdg || 0),
      usdg: total.usdg + (item.accruedFees?.usdgToken || 0),
      pair: total.pair + (item.accruedFees?.pair || 0),
    }),
    { value: 0, usdg: 0, pair: 0 },
  )
  elements.claimableFees.textContent = money(data.totals.accruedFees.usdg + directFees.value, 2)
  elements.feeTokens.textContent = `SPY ${tokenAmount(data.totals.accruedFees.spy)} · USDG ${tokenAmount(directFees.usdg)} · PAIR ${tokenAmount(data.totals.accruedFees.pair + directFees.pair)}`
  elements.windowVolumeLabel.textContent = `${data.analytics.label}成交`
  elements.windowVolume.textContent = money(data.analytics.totals.volumeUsdg)
  elements.windowGrossFee.textContent = `全池费用估算 ${money(data.analytics.totals.grossFeeUsdg, 2)}`
  elements.volumeTitle.textContent = `${data.analytics.label}单边成交量`
  elements.coverageNote.textContent = data.analytics.partialBeforeAnchor
    ? `历史仅覆盖 ${localTime(data.history.anchorTime)} 之后`
    : `共 ${data.analytics.swapEvents.toLocaleString('en-US')} 笔 Swap · 按成交时 SPY 估值`
  elements.positionVerification.textContent =
    data.dataQuality.positionVerification === 'verified'
      ? '✓ NFT owner / liquidity 已在同一区块核验'
      : '△ 仓位核验不完整，请查看数据源'
  elements.positionVerification.className = `verification ${data.dataQuality.positionVerification}`
  elements.footerUpdate.textContent = `最后有效快照 ${localTime(data.generatedAt)}`
  renderComparison(data)
  renderPortfolio(data)
  renderExternalStrategy(data)
  renderTrendModel(data)

  document.querySelectorAll('[data-window]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.window === data.selectedWindow))
  })

  const bins = data.analytics.bins
  drawChart(
    '#liquidity-chart',
    bins,
    {
      value: (item) => Number(item.marketLiquidity) / 1e22,
      secondary: { value: (item) => Number(item.ourLiquidity) / 1e22, color: 'var(--cyan)' },
      yFormat: (value) => value.toFixed(1),
      color: 'var(--acid)',
      area: true,
    },
    data,
  )
  drawChart(
    '#volume-chart',
    bins,
    {
      value: (item) => item.volumeUsdg,
      yFormat: (value) => compact(value, 1),
      color: 'var(--orange)',
      kind: 'bar',
    },
    data,
  )
  drawChart(
    '#efficiency-chart',
    bins,
    {
      value: (item) => item.feeUsdgPer1e20Liquidity,
      yFormat: (value) => compact(value, 1),
      color: 'var(--orange)',
      area: true,
      small: true,
    },
    data,
  )
  drawChart(
    '#share-chart',
    bins,
    {
      value: (item) => item.ourSharePct,
      yFormat: (value) => `${value.toFixed(1)}%`,
      color: 'var(--cyan)',
      area: true,
      small: true,
    },
    data,
  )
  renderPositions(data)
}

async function load() {
  if (state.request) return state.request
  const requestedWindow = state.window
  const request = (async () => {
    try {
      const response = await fetch(`/api/snapshot?window=${encodeURIComponent(requestedWindow)}`, { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok)
        throw new Error(payload.runtime?.progress?.message || payload.status || `HTTP ${response.status}`)
      const snapshotKey = `${payload.snapshotId || payload.pool?.blockHash || 'unknown'}:${payload.selectedWindow}`
      if (snapshotKey === state.snapshotKey) {
        state.data.runtime = payload.runtime
        setStatus(payload.runtime)
        return
      }
      state.snapshotKey = snapshotKey
      render(payload)
    } catch (error) {
      const runtime = state.data?.runtime || { status: 'ERROR', ageSeconds: null }
      setStatus({ ...runtime, status: 'ERROR' })
      elements.freshnessLine.textContent = error.message
    }
  })()
  state.request = request
  try {
    return await request
  } finally {
    if (state.request === request) state.request = null
    if (state.window !== requestedWindow) void load()
  }
}

document.querySelector('#window-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-window]')
  if (!button || button.dataset.window === state.window) return
  state.window = button.dataset.window
  document.querySelectorAll('[data-window]').forEach((item) => {
    item.setAttribute('aria-selected', String(item === button))
  })
  void load()
})

document.querySelector('#portfolio-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-portfolio-filter]')
  if (!button || button.dataset.portfolioFilter === state.portfolioFilter) return
  state.portfolioFilter = button.dataset.portfolioFilter
  if (state.data) renderPortfolio(state.data)
})

window.addEventListener(
  'resize',
  () => {
    if (state.data) render(state.data)
  },
  { passive: true },
)

document.addEventListener('visibilitychange', () => {
  if (state.poll) window.clearTimeout(state.poll)
  if (!document.hidden) void load()
  schedulePoll()
})

void load()
function schedulePoll() {
  if (state.poll) window.clearTimeout(state.poll)
  state.poll = window.setTimeout(
    async () => {
      await load()
      schedulePoll()
    },
    document.hidden ? 30_000 : 5_000,
  )
}
schedulePoll()
