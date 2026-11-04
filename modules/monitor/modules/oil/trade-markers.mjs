import { TRADE_TYPES, tradeVenueKey } from './trades.mjs';
import { decimalDifference } from './spread.mjs';

/** Absolute spreads are left − right in the venue's own quote currency. */
const absoluteSpread = venue => venue?.prices ? decimalDifference(venue.prices.left, venue.prices.right) : null;
const spreadText = (value, unit = 'percent') => value === null ? '未知' : unit === 'absolute' ? `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(3)}` : `${value.toFixed(3)}%`;
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
  const { event, chartSpread, basis, value, unit = 'percent' } = marker, type = TRADE_TYPES[event.type];
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
    `${basis} ${spreadText(value, unit)}${event.spreadVenue ? ` · ${labels.get(event.spreadVenue.key)}` : ''}`,
    `${chartLabel} ${spreadText(chartSpread, unit)}（${chartNote}）`,
    ...event.venues.flatMap(venue => [
      `${labels.get(venue.key)} · ${venue.direction}`,
      ...venue.legs.map(leg => `${leg.base} ${leg.sides.map(side => side === 'buy' ? '买' : '卖').join('/')} ${leg.quantity} ${leg.quantityUnit} @ ${leg.price} ${leg.currency}${priceUnit} · ${leg.scopes.join(' / ')}`),
      `成交价差 ${spreadText(unit === 'absolute' ? absoluteSpread(venue) : venue.spread, unit)}${venue.currency ? `（${venue.currency}${unit === 'absolute' ? priceUnit : ''}）` : ''}`,
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
