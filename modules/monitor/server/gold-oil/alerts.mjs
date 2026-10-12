import { GOLD_OIL_STALE_MS, GOLD_OIL_INSTRUMENTS, GOLD_OIL_EXCHANGES, goldOilUnits, validateGoldOilQuote } from '../../lib/gold-oil.ts';
import { validateConfig, evaluateRule } from '../oil/config.mjs';

export const goldOilAlertDefaults = () => ({ enabled: false, rules: [] });
export const validateGoldOilAlerts = (input, oilType = 'cl', exchange = 'binance') => validateConfig(input, {
  metrics: { ratio: `金油比 XAU / ${GOLD_OIL_INSTRUMENTS[oilType].code}` }, positiveMetrics: ['ratio'],
  thresholdError: `金油比阈值必须大于 0 且不超过 100 万（${goldOilUnits(oilType, exchange).ratio}）`,
});

export function goldOilAlertValues(input, now = Date.now(), oilType = 'cl', exchange = 'binance') {
  // Funding availability is independent of the mark-price ratio.
  const quote = validateGoldOilQuote({ ...input, funding: null }, oilType, exchange);
  const at = Date.parse(quote.fetchedAt);
  if (quote.status !== 'live' || input.collection?.stale || input.collection?.error || now - at > GOLD_OIL_STALE_MS || at > now + 1000) throw Error('金油比行情已过期或不可用，暂停阈值判断');
  return { ratio: quote.ratio, xau: quote.xau.price, oil: quote.oil.price };
}

/** Called inside the common notification queue immediately before delivery. */
export function confirmGoldOilTriggers(quote, due, now = Date.now(), oilType = 'cl', exchange = 'binance') {
  const values = goldOilAlertValues(quote, now, oilType, exchange);
  if (due.some(({ rule }) => !evaluateRule(rule, undefined, values[rule.metric], now).shouldSend)) throw Error('金油比已离开触发阈值，取消本次告警');
}

export function createGoldOilAlertDefinition(oilType = 'cl', exchange = 'binance') {
  const instrument = GOLD_OIL_INSTRUMENTS[oilType], source = GOLD_OIL_EXCHANGES[exchange]?.name, units = goldOilUnits(oilType, exchange);
  if (!instrument || !source) throw Error('Unsupported gold/oil instrument');
  return {
  source: exchange,
  service: `${exchange === 'bybit' ? 'bybit-' : ''}${oilType === 'cl' ? 'gold-oil-ratio-monitor' : 'gold-bz-ratio-monitor'}`, maxAgeMs: GOLD_OIL_STALE_MS, testTitle: `金油比阈值告警 · ${source} ${instrument.code}-XAU`,
  validateConfig: input => validateGoldOilAlerts(input, oilType, exchange), marketValues: (market, now) => goldOilAlertValues(market, now, oilType, exchange),
  message: (market, values, due) => [`金油比阈值告警 · ${source} ${instrument.code}-XAU`,
    `采集时间：${market.fetchedAt}（UTC）`,
    `价格口径：${source} XAUUSDT / ${instrument.symbol} 永续标记价；金油比＝XAU ÷ ${instrument.code}，${units.ratio === '报价比' ? '按两腿原始标记报价计算' : '单位桶/盎司'}`,
    ...due.map(({ rule, value, id }) => `【${rule.label}】金油比 ${value.toFixed(4)} ${rule.operator === 'gte' ? '≥' : '≤'} ${rule.threshold} ${units.ratio}\n事件 ${id}`),
    `黄金 ${values.xau.toFixed(4)} USDT/盎司 · 原油 ${values.oil.toFixed(4)} ${units.oil}`,
  ].join('\n'),
  };
}
export const goldOilAlertDefinition = createGoldOilAlertDefinition();
