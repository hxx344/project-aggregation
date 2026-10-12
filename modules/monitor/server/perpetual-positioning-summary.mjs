const EXCHANGES = ['binance', 'bybit', 'okx', 'bitget', 'gate'];
const SUPPORTED = new Set(EXCHANGES);
const PERIOD_MS = 300_000;
const STALE_MS = 900_000;
const ACCOUNT_SCOPE = '合约全体持仓账户（5 分钟）';
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** One stable USDT contract per venue, independent of the currently best spread. */
export function selectPositioningConstituents(base, quotes) {
  const selected = new Map();
  for (const quote of quotes ?? []) {
    if (!quote || !SUPPORTED.has(quote.exchange) || quote.base !== base || quote.comparable === false
      || quote.quoteCurrency !== 'USDT' || (quote.collateralCurrency != null && quote.collateralCurrency !== 'USDT')
      || typeof quote.symbol !== 'string' || !quote.symbol) continue;
    const previous = selected.get(quote.exchange);
    const standard = (quote.multiplier ?? 1) === 1, previousStandard = (previous?.multiplier ?? 1) === 1;
    if (!previous || (standard && !previousStandard) || (standard === previousStandard && quote.symbol < previous.symbol)) selected.set(quote.exchange, quote);
  }
  return EXCHANGES.map(exchange => {
    const quote = selected.get(exchange);
    return { exchange, key: quote ? `${exchange}:${quote.symbol}` : null, symbol: quote?.symbol ?? null };
  });
}

function ratioProblem(value, constituent, now) {
  if (!value || value.exchange !== constituent.exchange || value.symbol !== constituent.symbol) return '多空数据与所选合约不一致';
  if (value.kind !== 'accounts' || value.scope !== ACCOUNT_SCOPE) return '不是同口径的全体持仓账户数据';
  if (!finite(value.longRatio) || !finite(value.shortRatio) || value.longRatio < 0 || value.longRatio > 1
    || value.shortRatio < 0 || value.shortRatio > 1 || Math.abs(value.longRatio + value.shortRatio - 1) > 0.001) return '官方多空占比无效';
  if (!finite(value.observedAt) || value.observedAt <= 0 || !finite(now) || value.observedAt > now + 5_000) return '官方多空数据时间无效';
  return null;
}

/** A coverage-labelled exchange-equal sample, never a claimed global account count. */
export function summarizePositioning(constituents, ratios, attempts, now) {
  const input = new Map((constituents ?? []).map(row => [row.exchange, row]));
  const usable = [];
  const rows = EXCHANGES.map(exchange => {
    const candidate = input.get(exchange);
    const row = { exchange, key: candidate?.key ?? null, symbol: candidate?.symbol ?? null, status: 'pending', reason: null };
    if (!row.key || !row.symbol) {
      row.key = null; row.symbol = null; row.status = 'unsupported'; row.reason = '未发现该平台同币种USDT合约';
      return row;
    }
    const value = ratios.get(row.key), attempt = attempts.get(row.key);
    const error = typeof attempt?.error === 'string' && attempt.error ? attempt.error : null;
    if (attempt?.status === 'unsupported') {
      row.status = 'unsupported'; row.reason = error || '该合约暂无已接入的官方账户多空比'; return row;
    }
    if (!value) {
      row.status = ['error', 'rate-limited', 'unavailable'].includes(attempt?.status) ? attempt.status : error ? 'error' : 'pending';
      row.reason = error || ({ error: '多空接口暂不可用', 'rate-limited': '多空接口限流，等待重试', unavailable: '该合约暂无公开多空数据', pending: '等待后台采集官方多空比' })[row.status];
      return row;
    }
    const invalid = ratioProblem(value, row, now);
    if (invalid) { row.status = 'unavailable'; row.reason = error ? `${invalid}；${error}` : invalid; return row; }
    if (now - value.observedAt > STALE_MS) {
      row.status = 'stale'; row.reason = error ? `多空数据已过期；${error}` : '多空数据已过期'; return row;
    }
    row.status = 'fresh'; row.reason = error;
    usable.push({ row, value });
    return row;
  });
  // Align actual statistics times, not HTTP receipt times. One full 5m interval
  // accommodates the normal publishing lag of a venue without merging old cycles.
  const latestAt = usable.reduce((latest, item) => Math.max(latest, item.value.observedAt), 0);
  const included = usable.filter(({ row, value }) => {
    if (Math.floor(value.observedAt / PERIOD_MS) === Math.floor(latestAt / PERIOD_MS) || latestAt - value.observedAt <= PERIOD_MS) return true;
    row.status = 'stale'; row.reason = row.reason ? `统计时点不同，未纳入；${row.reason}` : '统计时点不同，未纳入';
    return false;
  });
  const enough = included.length >= 2;
  // Average account shares, not each venue's L/S quotient. Missing venues have
  // no vote. The complement preserves 100% despite source rounding differences.
  const longRatio = enough ? included.reduce((total, item) => total + item.value.longRatio, 0) / included.length : null;
  return { kind: 'accounts', method: 'equal-exchange', periodMs: PERIOD_MS,
    longRatio, shortRatio: longRatio === null ? null : 1 - longRatio,
    availableExchanges: included.length, eligibleExchanges: rows.filter(row => row.key !== null).length,
    totalExchanges: EXCHANGES.length, observedAt: enough ? Math.min(...included.map(item => item.value.observedAt)) : null,
    constituents: rows };
}
