import { D } from './money.mjs';

// Held contracts are read from each exchange's own public API. Monitor's
// cross-venue identity gate exists for new entries and must not hide the
// current rate of a contract the account already holds.
const REFRESH_MS = 30_000, IDENTITY_TTL_MS = 900_000, FUNDING_TTL_MS = 300_000, IDLE_MS = 600_000;
const MAX_FLIGHTS = 4, COOLDOWN_MS = 60_000;
const SYMBOL = /^(BINANCE|BYBIT|OKX|GATE|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]{1,30}_(USDT|USDC|USD)$/;
const time = value => Number.isSafeInteger(value) && value >= 1e12 && value < 5e12;
// Identity clients report an upstream limit as sourceStatus behind their own 502.
const limited = error => [error?.status, error?.sourceStatus].some(status => status === 418 || status === 429);

/** Synchronous view of a bounded background refresh. Each public read uses the
 * clients' 8 s deadline and is not retried within a cycle; the next attempt is
 * 30 s later, with at most four reads in flight, started in least-recent turn
 * order (independent of clock rollback) so every held symbol is covered. A 418
 * or 429 pauses that venue for 60 s before identity resolution and keeps the
 * native identity, which is otherwise reused for 15 minutes and dropped on any
 * failure. A rate is served only until its source time + 5 minutes; symbols
 * unused for 10 minutes are forgotten. */
export function createPositionFunding({ identityReader, currentReader, clock = Date.now }) {
  const entries = new Map(), cooldown = new Map();
  let active = 0, turn = 0, stopped = false;
  function leg(symbol, quote, value) {
    const exchange = symbol.split('_')[0].toLowerCase(), quoteCurrency = symbol.split('_').at(-1);
    const interval = value?.intervalHours, fundingAt = value?.sourceAt, now = clock();
    if (quote?.exchange !== exchange || !Number.isFinite(interval) || interval <= 0 || interval > 168
      || !time(fundingAt) || fundingAt > now + 1000) throw new Error('当前资金费周期或来源时间无效');
    const rate = D(value.rate);
    if (!rate.isFinite()) throw new Error('当前资金费无效');
    return { exchange, symbol, quoteCurrency, rate: rate.toNumber(), intervalHours: interval,
      normalized8hBps: rate.times(80000).div(interval).toNumber(),
      nextFundingAt: time(value.nextFundingAt) && value.nextFundingAt > now ? value.nextFundingAt : null,
      fundingAt, expiresAt: fundingAt + FUNDING_TTL_MS };
  }
  function start(symbol, entry, now) {
    entry.attemptAt = now; entry.turn = ++turn; active++;
    entry.flight = (async () => {
      const identity = entry.identity;
      if (!identity || now < identity.at || now - identity.at >= IDENTITY_TTL_MS) entry.identity = { at: now, quote: await identityReader(symbol) };
      const value = leg(symbol, entry.identity.quote, await currentReader(entry.identity.quote));
      // A cached value stamped in the future (local clock rolled back) cannot outrank a fresh read.
      if (!stopped && (!entry.value || value.fundingAt >= entry.value.fundingAt || entry.value.fundingAt > clock() + 1000)) entry.value = value;
    })().catch(error => {
      if (limited(error)) { cooldown.set(symbol.split('_')[0], clock() + COOLDOWN_MS); return; }
      // A changed or delisted contract must be re-resolved before the next read.
      entry.identity = null;
    }).finally(() => { entry.flight = null; active--; });
  }
  function rates(symbols = []) {
    const now = clock(), result = [], due = [];
    const wanted = [...new Set(Array.isArray(symbols) ? symbols : [])].filter(symbol => typeof symbol === 'string' && SYMBOL.test(symbol));
    for (const symbol of wanted) {
      let entry = entries.get(symbol);
      if (!entry) entries.set(symbol, entry = { attemptAt: -Infinity, turn: 0, value: null, identity: null, flight: null, usedAt: now });
      entry.usedAt = now;
      const venue = symbol.split('_')[0], until = cooldown.get(venue), cooling = until > now && until - now <= COOLDOWN_MS;
      if (until !== undefined && !cooling) cooldown.delete(venue);
      if (!entry.flight && !cooling && (now < entry.attemptAt || now - entry.attemptAt >= REFRESH_MS)) due.push([symbol, entry]);
      const value = entry.value;
      if (value && value.expiresAt > now && value.fundingAt <= now + 1000) result.push({ ...value });
    }
    due.sort(([, a], [, b]) => a.turn - b.turn);
    for (const [symbol, entry] of due) { if (stopped || active >= MAX_FLIGHTS) break; start(symbol, entry, now); }
    for (const [symbol, entry] of entries) if (!entry.flight && (now < entry.usedAt || now - entry.usedAt > IDLE_MS)) entries.delete(symbol);
    return result;
  }
  async function stop() { stopped = true; await Promise.all([...entries.values()].map(entry => entry.flight)); }
  return { rates, stop };
}
