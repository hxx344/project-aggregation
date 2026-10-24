import { TRADE_TYPES, tradeVenueKey } from './trades.mjs';
import { nearestTimeIndex } from './chart-performance.mjs';
import { OIL_CANDLE_MS } from './intraday.mjs';

const ns = 'http://www.w3.org/2000/svg';
export function visibleTradeMarkers(events, rows) {
  if (!rows.length) return [];
  const start = rows[0].time, end = rows.at(-1).time;
  return events.filter(event => event.time >= start && event.time <= end).map(event => {
    const nearest = rows[nearestTimeIndex(rows, event.time)];
    const chartSpread = nearest && Math.abs(nearest.time - event.time) <= OIL_CANDLE_MS && Number.isFinite(nearest.spread) ? nearest.spread : null;
    return { event, chartSpread, value: event.spread ?? chartSpread, basis: event.spread === null ? '图表价差' : '成交价差' };
  });
}
const spreadText = value => value === null ? '未知' : `${value.toFixed(3)}%`;
const cashText = totals => totals.map(item => `${item.amount === null ? item.known === null ? '未知' : `未知（已知 ${item.known}）` : item.amount} ${item.currency}`).join('；') || '未知';
function venueLabels(venues) {
  const groups = new Map(), labels = new Map();
  for (const venue of venues) {
    const displayKey = JSON.stringify([venue.source, venue.exchange, venue.account]);
    if (!groups.has(displayKey)) groups.set(displayKey, []);
    groups.get(displayKey).push(venue);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.key.localeCompare(b.key));
    group.forEach((venue, index) => labels.set(venue.key, `${venue.source}${group.length > 1 ? `（来源 ${index + 1}）` : ''} · ${venue.exchange} · ${venue.account}`));
  }
  return labels;
}
/** priceUnit, chartLabel and chartNote describe the market's quote unit, chart metric and sampling. */
export function tradeDetailLines(marker, formatTime, { priceUnit = '/桶', chartLabel = '图表同时刻价差', chartNote = '最近 15 分钟 K 线' } = {}) {
  const { event, chartSpread, basis, value } = marker, type = TRADE_TYPES[event.type];
  const labels = venueLabels(event.venues);
  const effects = { open: '开仓', close: '平仓', unknown: '开平未知' };
  const byFill = new Map();
  for (const effect of event.effects) {
    if (!byFill.has(effect.key)) byFill.set(effect.key, []);
    byFill.get(effect.key).push(effect);
  }
  return [
    `${type.symbol} ${type.label} · ${formatTime(event.time)} 北京时间`,
    `${event.fills.length} 笔成交 · 至 ${formatTime(event.end)}${event.stale ? ' · 保留旧数据' : ''}`,
    `${basis} ${spreadText(value)}${event.spreadVenue ? ` · ${labels.get(event.spreadVenue.key)}` : ''}`,
    `${chartLabel} ${spreadText(chartSpread)}（${chartNote}）`,
    ...event.venues.flatMap(venue => [
      `${labels.get(venue.key)} · ${venue.direction}`,
      ...venue.legs.map(leg => `${leg.base} ${leg.sides.map(side => side === 'buy' ? '买' : '卖').join('/')} ${leg.quantity} ${leg.quantityUnit} @ ${leg.price} ${leg.currency}${priceUnit} · ${leg.scopes.join(' / ')}`),
      `成交价差 ${spreadText(venue.spread)}${venue.currency ? `（${venue.currency}）` : ''}`,
      `手续费 ${cashText(venue.fees)} · 已实现盈亏 ${cashText(venue.realizedPnl)}`,
    ]),
    `手续费合计 ${cashText(event.fees)}（支出为负，返佣为正）`,
    `已实现盈亏合计 ${cashText(event.realizedPnl)}（不含手续费）`,
    ...event.fills.map(fill => {
      const parts = byFill.get(fill.key).map(effect => `${effects[effect.effect]} ${effect.quantity} ${fill.quantityUnit}`).join(' → ');
      return `${formatTime(fill.time)} · ${labels.get(tradeVenueKey(fill))} · ${fill.symbol} · ${parts}`;
    }),
  ];
}
export function fillsStatusText(view, formatTime) {
  const state = {
    standalone: '请在工作台中查看账户成交', unsupported: '工作台版本不支持成交读取', connecting: '正在连接工作台',
    loading: '读取中…', unauthorized: '登录状态不可用，请返回工作台重新登录', unavailable: view.timedOut ? '20 秒内未收到工作台回复' : '工作台暂时无法读取成交',
    // Stored fills are already on screen while Asset reads newer history.
    ok: view.pending ? view.coverage?.some(scope => scope.fetchedAt) ? '已显示上次成交，后台更新中…' : '读取中…' : '成交已更新',
  }[view.status] ?? '读取中…';
  const failed = view.coverage?.filter(scope => ['stale', 'error', 'unavailable'].includes(scope.status)).length ?? 0;
  const times = (view.coverage ?? []).map(scope => scope.fetchedAt).filter(Boolean).sort();
  // generatedAt is the response time, not the time a stale venue was successfully read.
  const through = times[0] ?? view.generatedAt;
  return [state, through ? `截至 ${formatTime(through)} 北京时间` : null,
    view.retained ? '刷新失败，保留上次成功数据' : null,
    failed ? `部分账户失败（${failed} 个范围）` : null,
    view.incomplete ? '覆盖不完整，部分成交开平未知或数据陈旧' : null,
    view.truncated ? '成交记录已截断' : null,
    '仅支持 Binance、Bybit、OKX', '最近 85 天',
  ].filter(Boolean).join(' · ');
}
/** Every user-controlled label is inserted as text, including SVG accessible names. */
export function renderTradeMarkers(svg, markers, chart, { formatTime, show, hide }) {
  const nodes = new Map(), doc = svg.ownerDocument;
  for (const marker of markers) {
    if (marker.value === null || !Number.isFinite(marker.value)) continue;
    const { event } = marker, type = TRADE_TYPES[event.type], px = chart.x(event.time), py = chart.y(marker.value);
    const node = doc.createElementNS(ns, 'g');
    node.setAttribute('class', 'oil-trade-marker');
    node.setAttribute('data-trade-type', event.type);
    node.setAttribute('transform', `translate(${px},${py})`);
    node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button');
    node.setAttribute('data-trade-key', event.key);
    node.setAttribute('aria-label', `${type.label} · ${formatTime(event.time)} 北京时间 · ${marker.basis} ${spreadText(marker.value)}，查看成交明细`);
    const hit = doc.createElementNS(ns, 'circle');
    hit.setAttribute('r', '12'); hit.setAttribute('fill', 'transparent');
    const symbol = doc.createElementNS(ns, 'text');
    symbol.setAttribute('text-anchor', 'middle'); symbol.setAttribute('dy', '.35em');
    symbol.setAttribute('aria-hidden', 'true'); symbol.textContent = type.symbol;
    node.append(hit, symbol);
    const display = event => { event?.stopPropagation(); show(marker, px); };
    node.addEventListener('pointerenter', display);
    node.addEventListener('pointermove', display);
    node.addEventListener('pointerdown', display);
    node.addEventListener('focus', display);
    node.addEventListener('click', display);
    node.addEventListener('blur', hide);
    node.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); hide(); }
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); display(event); }
    });
    svg.append(node); nodes.set(event.key, node);
  }
  return nodes;
}
export function createTradeLayer(root, formatTime) {
  const $ = id => root.getElementById(id), tooltip = $('trade-tooltip'), details = $('oil-trade-details');
  let markerNodes = new Map(), currentChart = null, shownKey = null;
  const hide = () => { tooltip.hidden = true; };
  const show = (marker, px) => {
    shownKey = marker.event.key;
    const lines = tradeDetailLines(marker, formatTime);
    tooltip.textContent = lines.join('\n'); tooltip.hidden = false;
    const width = $('main-chart').clientWidth;
    tooltip.style.left = `${Math.max(0, Math.min(px * width / currentChart.width + 12, width - tooltip.offsetWidth))}px`;
    tooltip.style.top = '38px';
    details.textContent = lines.join('\n'); details.hidden = false;
  };
  return {
    hide,
    render({ markers, chart, view, fillsView, beforeShow }) {
      currentChart = chart; hide();
      $('oil-trades').hidden = view !== 'spread';
      $('oil-trades-status').textContent = fillsStatusText(fillsView, formatTime);
      const display = (marker, px) => { if (!tooltip.hidden && shownKey === marker.event.key) return; beforeShow(); show(marker, px); };
      markerNodes = view === 'spread' && chart ? renderTradeMarkers($('main-chart'), markers, chart, { formatTime, show: display, hide }) : new Map();
      const list = $('oil-trades-list');
      list.replaceChildren(); details.hidden = true;
      if (!markers.length) {
        const empty = list.ownerDocument.createElement('p');
        empty.textContent = fillsView.status === 'ok' && !fillsView.pending && !fillsView.incomplete ? '当前图表区间暂无套利成交' : '当前图表区间暂无可展示成交';
        list.append(empty);
      }
      for (const marker of [...markers].reverse()) {
        const button = list.ownerDocument.createElement('button'), type = TRADE_TYPES[marker.event.type];
        button.type = 'button'; button.className = 'oil-trade-list-item';
        button.setAttribute('data-trade-type', marker.event.type);
        button.textContent = `${type.symbol} ${formatTime(marker.event.time)} · ${type.label} · ${marker.event.fills.length} 笔 · ${marker.basis} ${spreadText(marker.value)}`;
        button.addEventListener('click', () => {
          const node = markerNodes.get(marker.event.key);
          node?.focus(); node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          if (chart) display(marker, chart.x(marker.event.time));
        });
        list.append(button);
      }
    },
  };
}
