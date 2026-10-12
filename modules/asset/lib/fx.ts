import { finite, readJson } from './exchanges.ts';
import type { FxStatus } from './types';

type FxQuote = { rate: number; status: FxStatus };
function validRate(value: unknown) {
  const rate = finite(value, 'USD/CNY 汇率');
  if (rate <= 0 || rate > 1000) throw new Error('USD/CNY 汇率无效');
  return rate;
}

export async function yuanQuote(fetcher: typeof fetch = fetch, now = Date.now()): Promise<FxQuote> {
  const fetchedAt = new Date(now).toISOString();
  try {
    const data = await readJson('https://api.coinbase.com/v2/exchange-rates?currency=USD', { cache: 'no-store' }, fetcher);
    if (data.data?.currency !== 'USD') throw new Error('汇率基础币种错误');
    return { rate: validRate(data.data?.rates?.CNY), status: { source: 'Coinbase', fetchedAt, rateDate: null, error: null } };
  } catch {
    try {
      const data = await readJson('https://api.frankfurter.dev/v2/rate/USD/CNY?providers=ecb', { cache: 'no-store' }, fetcher);
      if (data.base !== 'USD' || data.quote !== 'CNY' || typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error('汇率币种或日期错误');
      const date = new Date(data.date + 'T00:00:00Z');
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== data.date || date.getTime() > now || now - date.getTime() > 7 * 86400000) throw new Error('参考汇率日期无效或过期');
      return { rate: validRate(data.rate), status: { source: 'Frankfurter', fetchedAt, rateDate: data.date, error: null } };
    } catch { throw new Error('人民币汇率更新失败，保留上次汇率'); }
  }
}
