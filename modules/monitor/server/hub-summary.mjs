import { oilSpreadPercent } from '../modules/oil/spread.mjs';
import { monitors } from '../lib/monitors.ts';
import { goldOilRatio, GOLD_OIL_INSTRUMENTS, GOLD_OIL_EXCHANGES, goldOilAction, goldOilUnits, validateGoldOilQuote } from '../lib/gold-oil.ts';
import { currentGoldOilFunding } from '../lib/gold-oil-funding.ts';
const timestamp = value => { const at = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(at) && at > 0 ? at : null; };
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const healthMessage = value => String(value).slice(0, 500);
const metric = (key, label, value, unit) => ({ key, label, value, unit });

/** Project only the selected module from resident caches; never fetch upstream or read history. */
export async function readHubSummary(services, now = Date.now(), monitorId = 'oil', oilType = 'cl', exchange = 'binance') {
  const entry = monitors.find(item => item.id === monitorId);
  if (!entry) throw new Error('监控模块不存在');
  if (monitorId === 'cl-xau' && !['cl', 'bz'].includes(oilType)) throw new Error('不支持此金油比原油合约');
  if (monitorId === 'cl-xau' && !['binance', 'bybit'].includes(exchange)) throw new Error('不支持此金油比交易所');
  const modules = metric('modules', '监控模块', monitors.length, '个');
  const runtime = services.get(monitorId)?.runtime?.();
  if (runtime && (!runtime.enabled || runtime.error)) return { updatedAt: null, health: { state: 'offline', message: `${entry.title}：${runtime.error || '监控已关闭'}`, staleAfterSeconds: 30 }, metrics: [modules] };
  if (monitorId === 'perpetual') {
    const value = services.get('perpetual')?.summary?.() ?? { state: 'offline', updatedAt: null, message: '永续采集未就绪', quoteCount: 0, exchangeCount: 0, liveExchangeCount: 0 };
    return { updatedAt: timestamp(value.updatedAt) ? new Date(value.updatedAt).toISOString() : null,
      health: { state: value.state, message: healthMessage(value.message || '永续合约监控已连接；更新时间取启用交易所最早消息时间'), staleAfterSeconds: 30 },
      metrics: [metric('exchanges', '启用交易所', value.exchangeCount, '个'), metric('live_exchanges', '在线交易所', value.liveExchangeCount, '个'), metric('quotes', '报价合约', value.quoteCount, '个'), modules] };
  }
  let quote = null;
  try {
    const value = await services.get(monitorId)?.handle(monitorId === 'cl-xau' ? goldOilAction('quote', oilType, exchange) : 'quote', 'GET') ?? null;
    quote = value && monitorId === 'cl-xau' ? { ...validateGoldOilQuote(value, oilType, exchange), collection: value.collection } : value;
  } catch { /* A missing or wrong-instrument cache is explicitly offline. */ }
  const at = timestamp(quote?.fetchedAt), staleAfterSeconds = monitorId === 'oil' ? 90 : monitorId === 'cl-xau' ? 75 : 35;
  const stale = quote && (!at || at > now + 1000 || now - at > staleAfterSeconds * 1000 || quote.status === 'snapshot' || quote.collection?.stale);
  if (monitorId === 'cl-xau') {
    const oil = finite(quote?.oil?.price), xau = finite(quote?.xau?.price), ratio = goldOilRatio(oil, xau), instrument = GOLD_OIL_INSTRUMENTS[oilType], units = goldOilUnits(oilType, exchange);
    const funding = currentGoldOilFunding(quote);
    return { updatedAt: at ? new Date(at).toISOString() : null,
      health: { state: !quote ? 'offline' : stale ? 'stale' : ratio === null ? 'partial' : 'online', staleAfterSeconds,
        message: healthMessage(`金油比：XAU ÷ ${instrument.code}，${units.ratio === '报价比' ? '按原始标记报价计算' : '单位桶/盎司'}；${GOLD_OIL_EXCHANGES[exchange].name} 标记价格${!quote ? '；后台尚未取得报价' : stale ? '；报价已过期，保留原时间' : ratio === null ? '；价格无效' : ''}`) },
      metrics: [metric('ratio', `金油比 XAU / ${instrument.code}`, ratio, units.ratio), metric('xau', '黄金 XAU', xau, 'USDT/盎司'), metric(oilType, `${instrument.name} ${instrument.code}`, oil, units.oil), metric('funding', '做空金油比资金费年化', funding ? funding.annualized * 100 : null, '%'), modules] };
  }
  const spreadPercent = monitorId === 'oil' ? oilSpreadPercent(finite(quote?.brent?.markPx), finite(quote?.wti?.markPx)) : null;
  const partial = monitorId === 'oil' && spreadPercent === null || quote?.status === 'partial' || quote?.status === 'connecting' || Boolean(quote?.collection?.error) || monitorId === 'hynix' && Boolean(quote?.fundingError);
  const state = !quote ? 'offline' : stale ? 'stale' : partial ? 'partial' : 'online';
  const detail = quote?.collection?.error || (monitorId === 'hynix' ? quote?.fundingError : '') || (!quote ? '后台尚未取得报价' : stale ? '报价已过期，保留原采集时间' : monitorId === 'oil' && spreadPercent === null ? '价格无效，价差暂不可用' : '');
  const brent = finite(quote?.brent?.markPx), wti = finite(quote?.wti?.markPx), annualized = finite(quote?.funding?.annualizedRate);
  return { updatedAt: at ? new Date(at).toISOString() : null,
    health: { state, message: healthMessage(entry.title + (detail ? '：' + detail : monitorId === 'oil' ? '监控已连接；Binance 标记价格，价差＝(布伦特 − WTI) ÷ WTI × 100%' : '监控已连接')), staleAfterSeconds },
    metrics: monitorId === 'oil' ? [metric('brent', '布伦特原油', brent, 'USDT/桶'), metric('wti', 'WTI 原油', wti, 'USDT/桶'), metric('spread', '布伦特相对 WTI 价差', spreadPercent, '%'), modules]
      : [metric('premium', 'ADR 溢价', finite(quote?.premium), '%'), metric('spread', 'ADR 与换算价格差', finite(quote?.spread), 'USD'), metric('funding', '资金费率年化', annualized === null ? null : annualized * 100, '%'), modules] };
}
