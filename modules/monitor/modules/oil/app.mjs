import { oilSpreadPercent } from './spread.mjs';
import { round, signed, filterRows, summarize, monthlyAverages, chartDomain } from './data-utils.mjs';
import { calculateShortSpreadFunding, DAY } from './binance.mjs';
import { validateFundingSnapshot, analyzeFundingWindow } from './binance-funding-history.mjs';

import { intradayChartRows, validateIntradaySnapshot, OIL_CANDLE_MS, OIL_CANDLE_ACTION } from './intraday.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { binanceOilExchangeQuote } from '../../lib/exchange-quotes.ts';
import { nearestTimeIndex, tablePage, samePriceRows } from './chart-performance.mjs';
import { startOilAutoRefresh } from './auto-refresh.mjs';
import { getQuoteStaleAfterMs } from '../../lib/market-freshness.ts';
/** @param {ShadowRoot} root @param {{ initial?: import('../../lib/initial-market').InitialMarketData['oil'], initialReadAt?: number, active?: boolean, summaryActive?: boolean, onSummary?: (summary: import('../../lib/monitor-summary').OilSummaryUpdate) => void }} options */
export function mount(root, { onSummary, initial, initialReadAt = 0, active = true, summaryActive = active } = {}) {
const life = createLifecycle();
let activityActive = active;
let overviewActive = summaryActive;
const $ = id => root.getElementById(id);
const state = { rows: [], range: '1w', view: 'spread', visible: [], chart: null, selectedDate: null, market: null, metadata: null, basis: 'quantity', marketMode: 'snapshot', historyMode: 'snapshot', refreshing: false, fundingSnapshot: null, fundingByTime: new Map(), fundingChart: null, fundingHistoryMode: 'loading', fundingRefreshing: false, tablePage: 0 };
const labels = { '1d': '近 1 天', '1w': '近 1 周', '1m': '近 1 月', all: '全部历史' };
let fundingHistoryView = 'annualized', fundingAnalysis = null, fundingAnalysisSource = null, fundingAnalysisRange = '';
let fundingRangeDaily = new Map();
const money = value => `${value.toFixed(3)}<small>USDT / 桶</small>`;
const shortDate = date => beijingTime(date).slice(5, -3);
const displayDate = date => date.length > 10 ? beijingTime(date).slice(0, -3) : date.replaceAll('-', '.');
const priceClass = value => value < 0 ? 'negative' : value > 0 ? 'positive' : '';
const ns = 'http://www.w3.org/2000/svg';
const percent = (value, digits = 5) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value * 100).toFixed(digits)}%`;
const timeFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const beijingTime = iso => timeFormatter.format(new Date(iso));
let tableDirty = true;
let summaryRows, summaryHistory, tablePreviousSource, tablePreviousRows;
let pointerFrame = 0, queuedPointer = null, chartDirty = true;
let refreshGeneration = 0, quoteGeneration = 0, fundingGeneration = 0;
const tableDetails = $('data-table').closest('details');

function publishSummary(status = state.marketMode) {
  if (life.signal.aborted) return;
  if (state.metadata && (summaryRows !== state.rows || summaryHistory?.status !== state.historyMode || summaryHistory?.fetchedAt !== state.metadata.fetchedAt)) {
    const points = summaryRows === state.rows ? summaryHistory.points : state.rows.map(row => ({ time: row.time, value: row.spread }));
    summaryRows = state.rows;
    summaryHistory = { points, status: state.historyMode, fetchedAt: state.metadata.fetchedAt };
  }
  onSummary?.({
    status,
    spread: state.market ? oilSpreadPercent(state.market.brent.markPx, state.market.wti.markPx) : null,
    fundingHourlyRate: state.market ? calculateShortSpreadFunding(state.market, state.basis).hourlyRate : null,
    fundingBasis: state.basis,
    fetchedAt: state.market?.fetchedAt ?? null,
    staleAfterMs: getQuoteStaleAfterMs(state.market, 75_000),
    comparison: state.market ? binanceOilExchangeQuote(state.market, status !== 'live') : undefined,
    history: summaryHistory,
  });
}

function showSignedValue(id, text, value) {
  const element = $(id);
  element.innerHTML = text;
  element.classList.toggle('positive', value > 0);
  element.classList.toggle('negative', value < 0);
}

function renderFunding() {
  if (!state.market) return;
  const result = calculateShortSpreadFunding(state.market, state.basis);
  if (result.hourlyRate === null) {
    for (const id of ['funding-net', 'funding-cash', 'funding-annual', 'brent-funding', 'wti-funding']) showSignedValue(id, '—', 0);
    $('funding-direction').textContent = '资金费暂不可用';
    for (const id of ['brent-payment', 'wti-payment', 'funding-formula', 'funding-basis-note']) $(id).textContent = '';
    $('funding-cash-caption').textContent = '等待有效费率和结算周期';
    $('funding-timestamp').textContent = `价格已保留：${beijingTime(state.market.fetchedAt)}（北京时间）`;
    root.querySelectorAll('[data-basis]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.basis === state.basis)));
    publishSummary(); return;
  }
  const direction = result.hourlyRate > 0 ? '净收款' : result.hourlyRate < 0 ? '净付款' : '收支持平';
  showSignedValue('funding-net', `${percent(result.hourlyRate)}<small>/ 小时</small>`, result.hourlyRate);
  showSignedValue('funding-cash', `${result.cashflowPer10k < 0 ? '−' : result.cashflowPer10k > 0 ? '+' : ''}${Math.abs(result.cashflowPer10k).toFixed(4)} USDT`, result.hourlyRate);
  showSignedValue('funding-annual', percent(result.annualizedRate, 2), result.hourlyRate);
  showSignedValue('funding-direction', direction, result.hourlyRate);
  $('funding-cash-caption').textContent = `两腿合计 10,000 USDT 标记名义金额 · ${direction}`;
  $('brent-funding').textContent = `${percent(state.market.brent.fundingRate)} / ${state.market.brent.fundingIntervalHours} h`;
  $('wti-funding').textContent = `${percent(state.market.wti.fundingRate)} / ${state.market.wti.fundingIntervalHours} h`;
  $('brent-payment').textContent = result.brentCashflow > 0 ? '空头收款' : result.brentCashflow < 0 ? '空头付款' : '无收付';
  $('wti-payment').textContent = result.wtiCashflow > 0 ? '多头收款' : result.wtiCashflow < 0 ? '多头付款' : '无收付';
  $('funding-formula').textContent = state.basis === 'quantity' ? '净小时率 = (布伦特标记价 × 布伦特费率 ÷ 布伦特周期小时 − WTI 标记价 × WTI 费率 ÷ WTI 周期小时) ÷ 两种标记价之和。' : '净小时率 = (布伦特小时费率 − WTI 小时费率) ÷ 2。两腿名义金额相等，费率差需除以两腿总金额。';
  $('funding-basis-note').textContent = state.basis === 'quantity' ? `空 1 桶布伦特、多 1 桶 WTI：预计每小时${result.hourlyCashflow < 0 ? '净付' : '净收'} ${Math.abs(result.hourlyCashflow).toFixed(6)} USDT；总名义 ${result.grossNotional.toFixed(3)} USDT。` : '两腿按标记价格定义等 USDT 名义，桶数不同；净率不以保证金或单腿名义为分母。';
  $('funding-timestamp').textContent = `${state.marketMode === 'live' ? '行情采集' : '保留数据'}：${beijingTime(state.market.fetchedAt)}（北京时间）`;
  root.querySelectorAll('[data-basis]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.basis === state.basis)));
  publishSummary();
}

function renderStatus() {
  if (state.market) {
    $('connection-status').textContent = state.marketMode === 'live' ? '行情已更新' : state.marketMode === 'stale' ? '更新失败 · 保留数据' : '备用快照';
    $('data-through').textContent = `${beijingTime(state.market.fetchedAt)} 北京时间`;
  }
  if (!state.metadata) return;
  $('data-notice').textContent = `15 分钟 K 线收盘价差 · ${displayDate(state.metadata.firstCommonObservation)} — ${displayDate(state.metadata.lastCommonObservation)} 北京时间。${state.metadata.missingObservationRows ? `缺少 ${state.metadata.missingObservationRows} 根共同 K 线，缺口断线。` : ''}${state.historyMode !== 'live' ? '历史更新中断，保留已存数据。' : ''}`;
  $('data-notice').hidden = false;
  $('source-note').textContent = `历史采用 Binance BZUSDT 与 CLUSDT 同一时段已收盘的 15 分钟 K 线，价格按 USDT/桶报价，价差＝(布伦特 − WTI) ÷ WTI × 100%。图表显示北京时间，按 UTC 对齐；从 4 月 1 日回补，后台持续保存新记录。采集：${beijingTime(state.metadata.fetchedAt)} 北京时间。`;
}

function svgElement(tag, attributes = {}, content) {
  const element = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (content !== undefined) element.textContent = content;
  return element;
}

function drawTimeTicks(svg, rows, width, height, x) {
  const count = Math.min(width < 500 ? 3 : 6, rows.length);
  const indices = [...new Set(Array.from({ length: count }, (_, i) => Math.round(i * (rows.length - 1) / (count - 1 || 1))))];
  indices.forEach((index, i) => {
    const row = rows[index], label = beijingTime(row.date), px = x(row.date);
    const text = svgElement('text', { x: px, y: height - 22, 'text-anchor': i === 0 ? 'start' : i === indices.length - 1 ? 'end' : 'middle' });
    text.append(svgElement('tspan', { x: px }, label.slice(5, 10)), svgElement('tspan', { x: px, dy: 15 }, label.slice(11, 16)));
    svg.append(text);
  });
}

function fillMetrics() {
  if (!state.market) return;
  const spread = oilSpreadPercent(state.market.brent.markPx, state.market.wti.markPx);
  $('latest-spread').innerHTML = spread === null ? '—' : `${signed(spread)}<small>%</small>`;
  $('latest-brent').innerHTML = money(state.market.brent.markPx);
  $('latest-wti').innerHTML = money(state.market.wti.markPx);
  $('spread-change').textContent = '(布伦特 − WTI) ÷ WTI × 100%';
  if (!state.rows.length) return;
  const { first, latest } = summarize(state.rows);
  const yearChange = round(latest.spread - first.spread);
  $('ytd-change').innerHTML = `${signed(yearChange)}<small>百分点</small>`;
  $('ytd-change').classList.toggle('negative', yearChange < 0);
  $('ytd-change').classList.toggle('positive', yearChange > 0);
  $('ytd-reference').textContent = `${shortDate(first.date)} — ${shortDate(latest.date)} · 15 分钟收盘价差`;
}

function renderSummary(summary) {
  $('summary-range').textContent = labels[state.range];
  $('average-spread').textContent = summary.average.toFixed(3);
  $('max-spread').textContent = `${summary.max.spread.toFixed(3)}%`;
  $('min-spread').textContent = `${summary.min.spread.toFixed(3)}%`;
  $('max-date').textContent = displayDate(summary.max.date);
  $('min-date').textContent = displayDate(summary.min.date);
  const span = summary.max.spread - summary.min.spread;
  const percentile = span === 0 ? 50 : (summary.latest.spread - summary.min.spread) / span * 100;
  $('range-marker').style.left = `clamp(0px, ${percentile.toFixed(3)}%, calc(100% - 3px))`;
  $('range-description').textContent = `最近收盘价差位于区间${percentile < 33 ? '下部' : percentile > 66 ? '上部' : '中部'} · ${summary.latest.spread.toFixed(3)}%`;
}

function renderMonthly() {
  const months = monthlyAverages(state.visible);
  const high = Math.max(...months.map(month => month.average), 0.1);
  const low = Math.min(...months.map(month => month.average), 0);
  const span = high - low;
  const zero = -low / span * 80;
  $('monthly-chart').replaceChildren();
  for (const month of months) {
    const item = document.createElement('div');
    item.className = 'month-item';
    item.setAttribute('role', 'listitem');
    item.tabIndex = 0;
    const description = `${Number(month.month.slice(5))}月：平均价差 ${month.average.toFixed(3)}%，${month.count} 根 15 分钟 K 线`;
    item.setAttribute('aria-label', description);
    item.title = description;
    const height = Math.abs(month.average) / span * 80;
    const bottom = month.average >= 0 ? zero : zero - height;
    item.innerHTML = `<div class="month-bar-area"><div class="month-zero" style="bottom:${zero}%"></div><div class="month-bar" style="height:${height}%;bottom:${bottom}%"></div><span class="month-value" style="bottom:calc(${month.average >= 0 ? zero + height : zero}% + 6px)">${month.average.toFixed(3)}</span></div><span class="month-label">${Number(month.month.slice(5))} 月</span>`;
    $('monthly-chart').append(item);
  }
  $('monthly-note').textContent = `${labels[state.range]} · 按所选区间内每根 15 分钟百分比价差取算术平均；首尾月份可能不完整。`;
}

function renderTable(changed = true) {
  if (changed) tableDirty = true;
  $('table-count').textContent = `${state.visible.length} 条记录`;
  // The default-collapsed detail table must not compete with the visible charts.
  if (!tableDetails.open || !tableDirty) return;
  const tbody = $('data-table');
  const page = tablePage(state.visible, state.tablePage);
  state.tablePage = page.page;
  $('table-page-status').textContent = `第 ${page.page + 1} / ${page.pages} 页 · ${page.first}–${page.last} 条`;
  $('table-prev').disabled = page.page === 0;
  $('table-next').disabled = page.page === page.pages - 1;
  tbody.replaceChildren();
  const fragment = document.createDocumentFragment();
  if (tablePreviousSource !== state.rows) {
    tablePreviousRows = new Map(state.rows.map((row, index) => [row.time, state.rows[index - 1]]));
    tablePreviousSource = state.rows;
  }
  for (const row of page.rows) {
    const previous = tablePreviousRows.get(row.time);
    const change = previous && row.time - previous.time === OIL_CANDLE_MS ? round(row.spread - previous.spread) : null;
    const tr = document.createElement('tr');
    const funding = state.fundingByTime.get(row.time);
    tr.innerHTML = `<td>${displayDate(row.date)}</td><td>${row.brent.toFixed(3)}</td><td>${row.wti.toFixed(3)}</td><td>${row.spread.toFixed(3)}%</td><td class="${change === null ? '' : priceClass(change)}">${change === null ? '—' : signed(change)}</td><td class="${funding ? priceClass(funding.longRate) : 'history-missing'}">${funding ? percent(funding.longRate) : '—'}</td><td class="${funding ? priceClass(funding.shortRate) : 'history-missing'}">${funding ? percent(funding.shortRate) : '—'}</td><td>${funding ? '4 小时已结算' : '—'}</td>`;
    fragment.append(tr);
  }
  tbody.append(fragment);
  tableDirty = false;
}

function renderChart() {
  const rows = state.visible;
  if (!rows.length) return;
  const svg = $('main-chart');
  if (!svg.clientWidth) { chartDirty = true; return; }
  chartDirty = false;
  const width = Math.max(Math.round(svg.clientWidth), 270);
  const height = Math.max(Math.round(svg.clientHeight), 250);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  const padding = { left: 62, right: 18, top: 20, bottom: 47 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const isSpread = state.view === 'spread';
  const summary = summarize(rows);
  const domain = chartDomain(isSpread ? rows.map(row => row.spread) : rows.flatMap(row => [row.wti, row.brent]));
  const start = Date.parse(rows[0].date), end = Date.parse(rows.at(-1).date);
  const x = date => padding.left + (start === end ? 0.5 : ((typeof date === 'number' ? date : Date.parse(date)) - start) / (end - start)) * plotWidth;
  const y = value => padding.top + (domain.max - value) / (domain.max - domain.min) * plotHeight;
  const baseline = y(Math.max(domain.min, Math.min(domain.max, 0)));
  const defs = svgElement('defs');
  const gradient = svgElement('linearGradient', { id: 'spread-fill', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradient.append(svgElement('stop', { offset: '0%', 'stop-color': 'var(--primary)', 'stop-opacity': '.20' }), svgElement('stop', { offset: '100%', 'stop-color': 'var(--primary)', 'stop-opacity': '.015' }));
  defs.append(gradient); svg.append(defs);
  svg.append(svgElement('title', {}, `${isSpread ? '布伦特相对WTI的百分比价差' : '布伦特与WTI永续合约收盘价'}，${rows[0].date}至${rows.at(-1).date}`));
  svg.append(svgElement('desc', {}, `共${rows.length}根共同 15 分钟 K 线。价差均值${summary.average.toFixed(3)}，最低${summary.min.spread.toFixed(3)}，最高${summary.max.spread.toFixed(3)}%。价差以 WTI 为基准。完整数值见页面下方15 分钟数据明细。`));
  for (let i = 0; i <= 4; i++) {
    const value = domain.min + (domain.max - domain.min) * i / 4;
    const py = y(value);
    svg.append(svgElement('line', { x1: padding.left, y1: py, x2: width - padding.right, y2: py, stroke: 'var(--border)', 'stroke-dasharray': '3 5' }));
    svg.append(svgElement('text', { x: padding.left - 11, y: py + 4, 'text-anchor': 'end' }, value.toFixed(Math.abs(value) >= 100 ? 0 : 1)));
  }
  if (isSpread && domain.min < 0 && domain.max > 0) {
    svg.append(svgElement('line', { x1: padding.left, y1: y(0), x2: width - padding.right, y2: y(0), stroke: 'var(--muted-foreground)', 'stroke-width': 1 }));
  }
  drawTimeTicks(svg, rows, width, height, x);
  if (isSpread) svg.append(svgElement('line', { x1: padding.left, y1: y(summary.average), x2: width - padding.right, y2: y(summary.average), stroke: 'var(--muted-foreground)', 'stroke-dasharray': '5 5', opacity: '.75' }));
  const series = isSpread ? [{ field: 'spread', color: 'var(--primary)' }] : [{ field: 'brent', color: 'var(--primary)' }, { field: 'wti', color: 'var(--chart-2)' }];
  for (const { field, color } of series) {
    const segments = [];
    for (const row of rows) {
      const last = segments.at(-1)?.at(-1);
      if (!last || Date.parse(row.date) - Date.parse(last.date) > OIL_CANDLE_MS) segments.push([]);
      segments.at(-1).push(row);
    }
    for (const segment of segments) {
      const path = segment.map((row, i) => `${i === 0 ? 'M' : 'L'}${x(row.date).toFixed(3)},${y(row[field]).toFixed(3)}`).join(' ');
      if (isSpread && segment.length > 1) svg.append(svgElement('path', { d: `${path} L${x(segment.at(-1).date)},${baseline} L${x(segment[0].date)},${baseline} Z`, fill: 'url(#spread-fill)' }));
      svg.append(svgElement('path', { d: path, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      if (segment.length === 1) svg.append(svgElement('circle', { cx: x(segment[0].date), cy: y(segment[0][field]), r: 2.5, fill: color }));
    }
    svg.append(svgElement('circle', { cx: x(rows.at(-1).date), cy: y(rows.at(-1)[field]), r: 4, fill: color, stroke: 'var(--card)', 'stroke-width': 2 }));
  }
  const crosshair = svgElement('g', { visibility: 'hidden', 'aria-hidden': 'true' });
  const guide = svgElement('line', { y1: padding.top, y2: height - padding.bottom, stroke: 'var(--muted-foreground)', 'stroke-dasharray': '3 4' });
  crosshair.append(guide);
  const dots = series.map(item => { const dot = svgElement('circle', { r: 4, fill: item.color, stroke: 'var(--card)', 'stroke-width': 2 }); crosshair.append(dot); return { field: item.field, node: dot }; });
  svg.append(crosshair);
  state.chart = { width, height, x, y, crosshair, guide, dots, padding, start, end, plotWidth };
  svg.setAttribute('aria-label', isSpread ? '布伦特相对WTI的15分钟K线收盘价差走势，单位百分比' : '布伦特和WTI永续合约15分钟K线收盘价格走势，单位USDT 每桶');
  const previousIndex = rows.findIndex(row => row.date === state.selectedDate);
  const cursorIndex = previousIndex >= 0 ? previousIndex : rows.length - 1;
  const selected = rows[cursorIndex];
  state.selectedDate = selected.date;
  $('chart-cursor').max = rows.length - 1;
  $('chart-cursor').value = cursorIndex;
  $('chart-cursor').setAttribute('aria-valuetext', cursorDescription(selected));
  renderFundingHistoryChart();
  hideTooltip();
  if (root.activeElement === $('chart-cursor')) showTooltip(cursorIndex);
  else if (root.activeElement === $('funding-history-cursor')) showFundingObservation(Number($('funding-history-cursor').value));
}

function renderFundingHistoryStatus() {
  const mode = state.fundingHistoryMode;
  $('funding-history-status').textContent = state.fundingSnapshot ? `${mode === 'live' ? '历史费率已同步' : mode === 'stale' ? '历史费率更新失败，保留数据' : '历史费率备用快照'} · ${beijingTime(state.fundingSnapshot.metadata.fetchedAt)} 北京时间。每 4 小时结算；不足 6 次结算的日期按已有共同结算记录折算小时率，缺失不补零。` : mode === 'error' ? '历史资金费率暂不可用；价格图表与当前预估仍可使用。可点击顶部刷新数据重试。' : '正在载入已结算资金费率。';
}

function renderFundingHistoryChart() {
  if (!state.chart || !state.visible.length) return;
  const svg = $('funding-history-chart');
  const firstDate = state.visible[0].date, lastDate = state.visible.at(-1).date;
  const rangeKey = `${firstDate}/${lastDate}`;
  const source = state.fundingSnapshot?.data;
  if (!fundingAnalysis || fundingAnalysisSource !== source || fundingAnalysisRange !== rangeKey) {
    fundingAnalysis = analyzeFundingWindow(source ?? [], Date.parse(firstDate), Date.parse(lastDate) + OIL_CANDLE_MS);
    fundingAnalysisSource = source; fundingAnalysisRange = rangeKey;
    fundingRangeDaily = new Map(fundingAnalysis.points.map(row => [row.date, row]));
  }
  const records = fundingAnalysis.points;
  const annualized = fundingHistoryView === 'annualized';
  const metricLabel = annualized ? '累计年化资金费率' : '日均小时资金费率';
  const fields = annualized ? ['longAnnualized', 'shortAnnualized'] : ['longRate', 'shortRate'];
  root.querySelectorAll('[data-funding-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fundingView === fundingHistoryView)));
  $('funding-history-unit').textContent = annualized ? '% / 年 · 简单年化' : '% / 小时 · 日均值';
  $('funding-history-range').textContent = `${labels[state.range]} · ${displayDate(firstDate)} — ${displayDate(lastDate)} · 北京时间；按 UTC 日汇总`;
  for (const direction of ['long', 'short']) {
    const value = fundingAnalysis[`${direction}Annualized`];
    showSignedValue(`funding-history-${direction}-annual`, value === null ? '—' : percent(value, 2), value ?? 0);
    const cumulative = fundingAnalysis[`${direction}Cumulative`];
    $(`funding-history-${direction}-cumulative`).textContent = cumulative === null ? '—' : percent(cumulative, 4);
  }
  const empty = $('funding-history-empty');
  svg.replaceChildren(); state.fundingChart = null;
  $('funding-history-tooltip').hidden = true;
  const mode = state.fundingHistoryMode;
  renderFundingHistoryStatus();
  $('funding-history-count').textContent = state.fundingSnapshot ? `${fundingAnalysis.count.toLocaleString('zh-CN')} / ${fundingAnalysis.expectedSettlements.toLocaleString('zh-CN')} 次共同结算 · ${fundingAnalysis.missingSettlements ? `缺少 ${fundingAnalysis.missingSettlements.toLocaleString('zh-CN')} 次结算，累计仅含已覆盖数据` : '覆盖完整'}` : '';
  if (records.length) svg.removeAttribute('hidden'); else svg.setAttribute('hidden', '');
  empty.hidden = Boolean(records.length);
  $('funding-history-cursor').disabled = !records.length;
  if (!records.length) { empty.textContent = mode === 'loading' ? '正在读取历史结算费率…' : mode === 'error' ? '历史资金费率暂不可用' : '所选区间暂无共同结算数据'; return; }
  const { width, padding } = state.chart;
  const x = date => state.chart.x(fundingRangeDaily.get(date)?.time ?? date);
  const height = Math.max(svg.clientHeight, 185);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const top = 15, bottom = 43;
  const maxAbs = Math.max(...records.map(row => Math.abs(row[fields[1]])), annualized ? 0.0001 : 0.000001) * 1.18;
  const axisDigits = Math.min(6, Math.max(annualized ? 1 : 3, 1 - Math.floor(Math.log10(maxAbs * 100))));
  const y = rate => top + (maxAbs - rate) / (2 * maxAbs) * (height - top - bottom);
  svg.setAttribute('aria-label', `历史做多与做空价差的${metricLabel}`);
  svg.append(svgElement('title', {}, `${metricLabel}，${firstDate}至${lastDate}`));
  svg.append(svgElement('desc', {}, `两腿等 USDT 名义，按两腿总敞口计算。做多为多布伦特空WTI，做空相反。正值收款，负值付款。累计年化为所选区间累计净结算费率除以（有效结算次数乘4小时），再乘8760，不复利。当前覆盖${fundingAnalysis.count}次结算，缺少${fundingAnalysis.missingSettlements}次结算。`));
  for (let i = -2; i <= 2; i++) {
    const value = maxAbs * i / 2;
    svg.append(svgElement('line', { x1: padding.left, x2: width - padding.right, y1: y(value), y2: y(value), stroke: i === 0 ? 'var(--muted-foreground)' : 'var(--border)', 'stroke-dasharray': i === 0 ? 'none' : '3 5' }));
    svg.append(svgElement('text', { x: padding.left - 9, y: y(value) + 4, 'text-anchor': 'end' }, `${(value * 100).toFixed(axisDigits)}%`));
  }
  drawTimeTicks(svg, state.visible, width, height, state.chart.x);
  const series = [{ field: fields[0], color: 'var(--chart-2)', dash: 'none' }, { field: fields[1], color: 'var(--warning)', dash: '5 3' }];
  for (const item of series) {
    let path = '', previous = null;
    for (const point of records) {
      const connected = previous && Date.parse(point.date) - Date.parse(previous.date) === DAY;
      path += `${connected ? 'L' : 'M'}${x(point.date).toFixed(3)},${y(point[item.field]).toFixed(3)} `;
      if (!connected || point.count < 6) svg.append(svgElement('circle', { cx: x(point.date), cy: y(point[item.field]), r: 2.5, fill: 'var(--card)', stroke: item.color, 'stroke-width': 1.5 }));
      previous = point;
    }
    svg.append(svgElement('path', { d: path, fill: 'none', stroke: item.color, 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-dasharray': item.dash }));
  }
  const crosshair = svgElement('g', { visibility: 'hidden', 'aria-hidden': 'true' });
  const guide = svgElement('line', { y1: top, y2: height - bottom, stroke: 'var(--muted-foreground)', 'stroke-dasharray': '3 4' });
  crosshair.append(guide);
  const dots = series.map(item => { const dot = svgElement('circle', { r: 4, fill: item.color, stroke: 'var(--card)', 'stroke-width': 2 }); crosshair.append(dot); return { field: item.field, node: dot }; });
  svg.append(crosshair);
  state.fundingChart = { width, x, y, crosshair, guide, dots };
  $('funding-history-cursor').max = records.length - 1;
  const index = Math.max(0, records.findIndex(row => row.date === state.selectedDate?.slice(0, 10)));
  $('funding-history-cursor').value = index;
  $('funding-history-cursor').setAttribute('aria-valuetext', historicalFundingDescription(records[index].date));
  if (root.activeElement === $('funding-history-cursor')) showFundingObservation(index);
  else if (root.activeElement === $('chart-cursor')) showTooltip(Number($('chart-cursor').value));
}

function historicalFundingDescription(date) {
  const row = fundingRangeDaily.get(date), annualized = fundingHistoryView === 'annualized';
  return row ? `${date}，做多价差 ${percent(annualized ? row.longAnnualized : row.longRate, annualized ? 2 : 5)}，做空价差 ${percent(annualized ? row.shortAnnualized : row.shortRate, annualized ? 2 : 5)}，${annualized ? '区间累计年化' : '日均小时费率'}，等名义总敞口，当日${row.count}次结算，区间累计${row.cumulativeCount}次有效结算` : `${date}，没有共同历史资金费率样本`;
}

function showHistoricalFundingTooltip(date) {
  const chart = state.fundingChart;
  if (!chart) return;
  const row = fundingRangeDaily.get(date), px = chart.x(date), annualized = fundingHistoryView === 'annualized';
  const tooltip = $('funding-history-tooltip');
  chart.crosshair.setAttribute('visibility', row ? 'visible' : 'hidden');
  if (row) {
    chart.guide.setAttribute('x1', px); chart.guide.setAttribute('x2', px);
    for (const dot of chart.dots) { dot.node.setAttribute('cx', px); dot.node.setAttribute('cy', chart.y(row[dot.field])); }
  }
  tooltip.innerHTML = `<div class="tooltip-date">${displayDate(date)} · UTC 结算日</div>${row ? `<div class="tooltip-row funding-history-tooltip-long"><span>做多${annualized ? '年化' : '小时率'}</span><strong>${percent(annualized ? row.longAnnualized : row.longRate, annualized ? 2 : 5)}</strong></div><div class="tooltip-row funding-history-tooltip-short"><span>做空${annualized ? '年化' : '小时率'}</span><strong>${percent(annualized ? row.shortAnnualized : row.shortRate, annualized ? 2 : 5)}</strong></div><div class="tooltip-row"><span>做多累计</span><strong>${percent(row.longCumulative, 4)}</strong></div><div class="tooltip-row"><span>做空累计</span><strong>${percent(row.shortCumulative, 4)}</strong></div><div class="tooltip-date">区间内当日 ${row.count} 次 4 小时结算<br>从区间起点累计 ${row.cumulativeCount} 次有效结算</div>` : '<div>当日无共同结算样本</div>'}`;
  tooltip.hidden = false;
  const displayWidth = $('funding-history-chart').clientWidth;
  tooltip.style.left = `${Math.max(0, Math.min(px * displayWidth / chart.width + 14, displayWidth - tooltip.offsetWidth))}px`;
  tooltip.style.top = '29px';
  $('funding-history-cursor').setAttribute('aria-valuetext', historicalFundingDescription(date));
}

function cursorDescription(row) {
  return `${displayDate(row.date)} 北京时间，布伦特 ${row.brent.toFixed(3)} USDT/桶，WTI ${row.wti.toFixed(3)} USDT/桶，价差 ${row.spread.toFixed(3)}%`;
}

function showTooltip(index) {
  const row = state.visible[index], chart = state.chart;
  if (!row || !chart) return;
  state.selectedDate = row.date;
  const px = chart.x(row.date);
  chart.crosshair.setAttribute('visibility', 'visible');
  chart.guide.setAttribute('x1', px); chart.guide.setAttribute('x2', px);
  for (const dot of chart.dots) { dot.node.setAttribute('cx', px); dot.node.setAttribute('cy', chart.y(row[dot.field])); }
  const tooltip = $('chart-tooltip');
  tooltip.innerHTML = `<div class="tooltip-date">${displayDate(row.date)} · 北京时间</div><div class="tooltip-row"><span>布伦特</span><strong>${row.brent.toFixed(3)}</strong></div><div class="tooltip-row"><span>WTI</span><strong>${row.wti.toFixed(3)}</strong></div><div class="tooltip-row accent-text"><span>价差</span><strong>${signed(row.spread)}%</strong></div>`;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.max(0, Math.min(px + 14, chart.width - tooltip.offsetWidth))}px`;
  tooltip.style.top = '38px';
  $('chart-cursor').setAttribute('aria-valuetext', cursorDescription(row));
  $('chart-cursor').value = index;
  const fundingIndex = fundingAnalysis?.points.findIndex(point => point.date === row.date.slice(0, 10)) ?? -1;
  if (fundingIndex >= 0) $('funding-history-cursor').value = fundingIndex;
  showHistoricalFundingTooltip(row.date.slice(0, 10));
}

function showFundingObservation(index) {
  const point = fundingAnalysis?.points[index];
  if (!point) return;
  const priceIndex = state.visible.findIndex(row => row.time === point.time);
  if (priceIndex >= 0) showTooltip(priceIndex);
  else { hideTooltip(); state.selectedDate = point.date; showHistoricalFundingTooltip(point.date); }
  $('funding-history-cursor').value = index;
}

function hideTooltip() {
  cancelAnimationFrame(pointerFrame); pointerFrame = 0; queuedPointer = null;
  $('chart-tooltip').hidden = true;
  state.chart?.crosshair.setAttribute('visibility', 'hidden');
  $('funding-history-tooltip').hidden = true;
  state.fundingChart?.crosshair.setAttribute('visibility', 'hidden');
}

function render(full = true) {
  state.visible = filterRows(state.rows, state.range, OIL_CANDLE_MS);
  const summary = summarize(state.visible);
  $('range-caption').textContent = `${displayDate(summary.first.date)} — ${displayDate(summary.latest.date)} · 北京时间 · 15 分钟 K 线收盘`;
  $('observation-count').textContent = `${summary.count} 根共同 15 分钟 K 线`;
  $('chart-title').textContent = state.view === 'spread' ? '布伦特相对 WTI 价差' : '两种原油永续合约的收盘价';
  $('chart-axis-unit').textContent = state.view === 'spread' ? '%' : 'USDT / 桶';
  $('chart-legend').innerHTML = state.view === 'spread' ? '<span><i class="legend-line brent"></i>15 分钟价差</span><span><i class="legend-line average"></i>区间均值</span>' : '<span><i class="legend-line brent"></i>布伦特</span><span><i class="legend-line wti"></i>WTI</span>';
  root.querySelectorAll('[data-range]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.range === state.range)));
  root.querySelectorAll('[data-view]').forEach(button => { const active = button.dataset.view === state.view; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  $('chart-content').setAttribute('aria-labelledby', `${state.view}-tab`);
  if (full) { renderSummary(summary); renderMonthly(); renderTable(); }
  renderChart();
}

function applySnapshot(snapshot, mode) {
  if (life.signal.aborted) return;
  if (state.metadata && Date.parse(snapshot.metadata.fetchedAt) < Date.parse(state.metadata.fetchedAt)) return;
  const validated = validateIntradaySnapshot(snapshot);
  const changed = !samePriceRows(state.rows, validated.data.filter(row => row.brent !== null && row.wti !== null));
  if (changed) state.rows = intradayChartRows(validated);
  state.metadata = validated.metadata; state.historyMode = mode;
  $('loading').hidden = true; $('error').hidden = true; $('dashboard').hidden = false;
  if (changed) { fillMetrics(); render(); }
  renderStatus(); publishSummary();
}

function applyLiveMarket(market) {
  if (life.signal.aborted) return;
  if (state.market && Date.parse(market.fetchedAt) < Date.parse(state.market.fetchedAt)) return;
  calculateShortSpreadFunding(market);
  if (!Number.isFinite(Date.parse(market.fetchedAt)) || ![market.brent.markPx, market.wti.markPx].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid market quote');
  state.market = market; state.marketMode = market.status === 'snapshot' ? 'stale' : 'live';
  fillMetrics(); renderFunding(); renderStatus();
}

async function readMarketData(action, signal) {
  const response = await life.fetch(`/api/monitors/oil/${action}`, { cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
  if (!response.ok) throw new Error(`Market data HTTP ${response.status}`);
  const data = await response.json();
  signal?.throwIfAborted();
  return data;
}

async function refreshQuote(signal) {
  if (life.signal.aborted || !overviewActive) return;
  const generation = ++quoteGeneration;
  const market = await readMarketData('quote', signal);
  if (generation === quoteGeneration) applyLiveMarket(market);
}

function quoteFailed(error) {
  console.warn('Unable to refresh Binance quote:', error);
  state.marketMode = state.market ? 'stale' : 'error';
  if (!state.market) {
    $('connection-status').textContent = '连接失败';
    $('data-through').textContent = '数据暂不可用';
  }
  renderFunding(); renderStatus(); publishSummary();
}

async function refreshHistory(signal) {
  if (life.signal.aborted || !activityActive) return;
  const generation = ++refreshGeneration;
  state.refreshing = true; $('refresh-data').disabled = true;
  if (!state.rows.length) { $('loading').hidden = false; $('error').hidden = true; }
  try {
    const snapshot = await readMarketData(OIL_CANDLE_ACTION, signal);
    if (generation === refreshGeneration) applySnapshot(snapshot, snapshot.status === 'snapshot' ? 'snapshot' : 'live');
  } finally { if (life.signal.aborted || generation !== refreshGeneration) return; state.refreshing = false; $('refresh-data').disabled = false; }
}

function historyFailed(error) {
  console.warn('Unable to refresh Binance observations:', error);
  state.refreshing = false; $('refresh-data').disabled = false;
  state.historyMode = state.rows.length ? 'stale' : 'error';
  renderStatus(); publishSummary();
  if (!state.rows.length) {
    $('loading').hidden = true; $('error').hidden = false; $('dashboard').hidden = true;
  }
}

function applyFundingSnapshot(snapshot, mode) {
  if (life.signal.aborted) return;
  if (state.fundingSnapshot && Date.parse(snapshot.metadata.fetchedAt) < Date.parse(state.fundingSnapshot.metadata.fetchedAt)) return;
  const validated = validateFundingSnapshot(snapshot);
  if (validated.metadata.pairedObservationRows !== snapshot.metadata.pairedObservationRows || validated.metadata.firstSettlementTime !== snapshot.metadata.firstSettlementTime || validated.metadata.lastSettlementTime !== snapshot.metadata.lastSettlementTime) throw new Error('Funding metadata mismatch');
  const changed = !state.fundingSnapshot || !samePriceRows(state.fundingSnapshot.data, validated.data);
  state.fundingSnapshot = changed ? validated : { ...validated, data: state.fundingSnapshot.data }; state.fundingHistoryMode = mode;
  if (changed) state.fundingByTime = new Map(validated.data.filter(row => row.brent !== null && row.wti !== null).map(row => [row.time, { shortRate: (row.brent - row.wti) / 2, longRate: (row.wti - row.brent) / 2 }]));
  if (state.visible.length) { if (changed) { renderFundingHistoryChart(); renderTable(); } else renderFundingHistoryStatus(); }
}

async function refreshHistoricalFunding(signal) {
  if (life.signal.aborted || !activityActive) return;
  const generation = ++fundingGeneration;
  state.fundingRefreshing = true;
  try { const snapshot = await readMarketData('funding', signal); if (generation === fundingGeneration) applyFundingSnapshot(snapshot, snapshot.status === 'snapshot' ? 'snapshot' : 'live'); }
  finally { if (life.signal.aborted || generation !== fundingGeneration) return; state.fundingRefreshing = false; }
}

function fundingFailed(error) {
  console.warn('Unable to update settled funding history:', error);
  state.fundingRefreshing = false;
  state.fundingHistoryMode = state.fundingSnapshot ? 'stale' : 'error';
  if (state.fundingSnapshot) renderFundingHistoryStatus(); else renderFundingHistoryChart();
}

root.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => { if (state.range === button.dataset.range) return; state.range = button.dataset.range; state.tablePage = 0; render(); }));
root.querySelectorAll('[data-funding-view]').forEach(button => life.on(button, 'click', () => { fundingHistoryView = button.dataset.fundingView; renderFundingHistoryChart(); }));
const tabs = [...root.querySelectorAll('[data-view]')];
for (const button of tabs) {
  button.addEventListener('click', () => { state.view = button.dataset.view; render(false); });
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(tabs.indexOf(button) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    state.view = next.dataset.view; render(false); next.focus();
  });
}
life.on(tableDetails, 'toggle', () => { if (tableDetails.open) renderTable(false); });
for (const [id, step] of [['table-prev', -1], ['table-next', 1]]) life.on($(id), 'click', () => {
  state.tablePage += step; renderTable(); $('data-table').closest('.table-scroll').scrollTop = 0;
});
function handleChartPointer(event) {
  queuedPointer = { element: event.currentTarget, clientX: event.clientX };
  if (pointerFrame) return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0;
    const pointer = queuedPointer; queuedPointer = null;
    if (!pointer || life.signal.aborted) return;
    if (!state.chart) return;
    const rect = pointer.element.getBoundingClientRect();
    const px = (pointer.clientX - rect.left) * state.chart.width / rect.width;
    const target = state.chart.start + (px - state.chart.padding.left) / state.chart.plotWidth * (state.chart.end - state.chart.start);
    const funding = pointer.element.id === 'funding-history-chart';
    const rows = funding ? fundingAnalysis?.points ?? [] : state.visible;
    if (!rows.length) return;
    const index = nearestTimeIndex(rows, target);
    if (!funding && !$('chart-tooltip').hidden && state.selectedDate === rows[index].date) return;
    if (funding) showFundingObservation(index);
    else { $('chart-cursor').value = index; showTooltip(index); }
  });
}
$('main-chart').addEventListener('pointermove', handleChartPointer);
$('funding-history-chart').addEventListener('pointermove', handleChartPointer);
$('funding-history-chart').addEventListener('pointerleave', hideTooltip);
$('funding-history-chart').addEventListener('pointerdown', event => { if (event.pointerType === 'touch') $('funding-history-chart').dispatchEvent(new PointerEvent('pointermove', { clientX: event.clientX, clientY: event.clientY })); });
$('funding-history-cursor').addEventListener('input', event => showFundingObservation(Number(event.target.value)));
$('funding-history-cursor').addEventListener('focus', event => showFundingObservation(Number(event.target.value)));
$('funding-history-cursor').addEventListener('blur', hideTooltip);
$('funding-history-cursor').addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
$('main-chart').addEventListener('pointerleave', hideTooltip);
$('main-chart').addEventListener('pointerdown', event => { if (event.pointerType === 'touch') $('main-chart').dispatchEvent(new PointerEvent('pointermove', { clientX: event.clientX, clientY: event.clientY })); });
$('chart-cursor').addEventListener('input', event => showTooltip(Number(event.target.value)));
$('chart-cursor').addEventListener('focus', event => showTooltip(Number(event.target.value)));
$('chart-cursor').addEventListener('blur', hideTooltip);
$('chart-cursor').addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
$('retry').addEventListener('click', () => { void stopAutoRefresh.refresh(); });
$('refresh-data').addEventListener('click', () => { void stopAutoRefresh.refresh(); });
root.querySelectorAll('[data-basis]').forEach(button => button.addEventListener('click', () => { state.basis = button.dataset.basis; renderFunding(); }));
const stopAutoRefresh = startOilAutoRefresh({ quote: refreshQuote, prices: refreshHistory, funding: refreshHistoricalFunding, active, summaryActive, onQuoteError: quoteFailed, onHistoryError: historyFailed, onFundingError: fundingFailed });
let resizeFrame;
const resizeObserver = new ResizeObserver(() => { if (life.signal.aborted) return; cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => {
  const svg = $('main-chart');
  if (!life.signal.aborted && state.visible.length && svg.clientWidth && (chartDirty || Math.max(Math.round(svg.clientWidth), 270) !== state.chart?.width || Math.max(Math.round(svg.clientHeight), 250) !== state.chart?.height)) renderChart();
}); }); resizeObserver.observe($('chart-area'));


// Hydrate persisted data before starting refreshes; preserve the server-rendered cards.
if (initial?.quote) applyLiveMarket(initial.quote);
if (initial?.candles) applySnapshot(initial.candles, initial.candles.status === 'snapshot' ? 'snapshot' : 'live');
if (!state.market) publishSummary('loading');
void stopAutoRefresh.refreshQuote();
if (!initial?.candles || Date.now() - initialReadAt >= 60_000) void stopAutoRefresh.refreshHistory();
void stopAutoRefresh.refreshFunding();
return { setActive(value) { activityActive = value; stopAutoRefresh.setActive(value); }, setSummaryActive(value) { overviewActive = value; stopAutoRefresh.setSummaryActive(value); }, setView(input) { if (!['1d','1w','1m','all'].includes(input.range) || !['spread','prices'].includes(input.view)) throw new Error('Invalid chart view'); if (!state.rows.length) throw new Error('行情尚未加载'); if (state.range !== input.range) state.tablePage=0; state.range=input.range; state.view=input.view; render(); return summarize(state.visible); }, dispose() { life.dispose(); stopAutoRefresh(); resizeObserver.disconnect(); cancelAnimationFrame(resizeFrame); cancelAnimationFrame(pointerFrame); } };

}
