import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Clock3, RefreshCw } from 'lucide-react';
import { api, ApiError } from './api';
import { pairExchanges } from './trading-cache';
import type { TradingExchange, TradingPair } from './trading-types';
import type { AnthropicShares, ExecutionQuotes } from './trading-execution-types';
import { crossEdge, crossSpread, formatPercent, formatPrice, formatSigned, readBook, SPREAD_MARKETS, venueSpread } from './trading-spread';
import type { BookRead, Spread, SpreadMarket } from './trading-spread';
import { bestPairs, DEFAULT_SHARES, sharesProblem, shareBooks } from './trading-anthropic';
import './trading-execution.css';

const EXCHANGES: Record<TradingExchange, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX' };
const POLL_MS = 3000;
/** Without a successful read for this long the shown quotes are marked stale. */
const STALE_MS = 15_000;
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const time = (value: string) => Number.isFinite(Date.parse(value)) ? timeFormat.format(Date.parse(value)) : '—';

function Quote({ read }: { read: BookRead }) {
  if (!read.book) return <span className="spread-error" title={read.error ?? undefined}>{read.error ?? '—'}</span>;
  const { bid, ask, digits, stale, at } = read.book;
  return <span className={stale ? 'spread-stale' : undefined} title={`盘口时间 ${time(at)}${stale ? '（已过期）' : ''}`}>{formatPrice(bid, digits - 1)} / {formatPrice(ask, digits - 1)}</span>;
}
function Value({ spread, percentDigits = 3, unit = '%' }: { spread: Spread | null; percentDigits?: number; unit?: string }) {
  if (!spread) return <><td>—</td><td>—</td></>;
  const tone = spread.stale ? 'spread-stale' : spread.value > 0 ? 'spread-up' : spread.value < 0 ? 'spread-down' : undefined;
  return <><td className={tone}>{formatSigned(spread.value, spread.digits)}</td><td className={tone}>{unit === '%' ? formatPercent(spread.percent, percentDigits) : `${formatSigned(spread.percent, percentDigits)} ${unit}`}</td></>;
}

const VENUES: TradingExchange[] = ['binance', 'bybit', 'okx'];
type Reads = Record<TradingExchange, { base: BookRead; other: BookRead }>;
const readAll = (market: SpreadMarket, quotes: ExecutionQuotes): Reads => Object.fromEntries(VENUES.map(exchange => [exchange, { base: readBook(quotes, exchange, SPREAD_MARKETS[market].base), other: readBook(quotes, exchange, SPREAD_MARKETS[market].other) }])) as Reads;

/** Same-venue spreads on every exchange: the main view, since most trades are on one venue. */
function VenueTable({ market, quotes }: { market: SpreadMarket; quotes: ExecutionQuotes }) {
  const config = SPREAD_MARKETS[market], reads = readAll(market, quotes);
  return <div className="execution-table-wrap"><table className="execution-progress-table spread-table">
    <caption>{config.name} · 同所价差 {config.spreadLabel}</caption>
    <thead><tr><th scope="col">交易所</th><th scope="col">{config.baseLabel} 买一 / 卖一</th><th scope="col">{config.otherLabel} 买一 / 卖一</th><th scope="col">价差</th><th scope="col">百分比</th></tr></thead>
    <tbody>{VENUES.map(exchange => <tr key={exchange}><th scope="row">{EXCHANGES[exchange]}</th><td><Quote read={reads[exchange].base} /></td><td><Quote read={reads[exchange].other} /></td><Value spread={venueSpread(market, reads[exchange].base.book, reads[exchange].other.book)} /></tr>)}</tbody>
  </table></div>;
}

/** Cross-venue view for the selected pair: same contract across venues, and the four-leg spread gap. */
function CrossTable({ market, quotes, pair }: { market: SpreadMarket; quotes: ExecutionQuotes; pair: [TradingExchange, TradingExchange] }) {
  const config = SPREAD_MARKETS[market], reads = readAll(market, quotes);
  const [first, second] = pair.map(exchange => venueSpread(market, reads[exchange].base.book, reads[exchange].other.book));
  const gap: Spread | null = first && second ? { value: first.value - second.value, percent: first.percent - second.percent, digits: Math.max(first.digits, second.digits), stale: first.stale || second.stale } : null;
  const legs: Array<[string, 'base' | 'other']> = [[config.baseLabel, 'base'], [config.otherLabel, 'other']];
  return <div className="execution-table-wrap"><table className="execution-progress-table spread-table">
    <caption>{config.name} · {EXCHANGES[pair[0]]} − {EXCHANGES[pair[1]]}（中间价）</caption>
    <thead><tr><th scope="col">合约</th><th scope="col">{EXCHANGES[pair[0]]} 中间价</th><th scope="col">{EXCHANGES[pair[1]]} 中间价</th><th scope="col">价差</th><th scope="col">百分比</th><th scope="col">最优可成交</th></tr></thead>
    <tbody>
      {legs.map(([label, leg]) => {
        const a = reads[pair[0]][leg].book, b = reads[pair[1]][leg].book, edge = crossEdge(pair, a, b);
        return <tr key={label}><th scope="row">{label}</th><td>{a ? formatPrice(a.mid, a.digits) : '—'}</td><td>{b ? formatPrice(b.mid, b.digits) : '—'}</td><Value spread={crossSpread(a, b)} />
          <td className={edge?.stale ? 'spread-stale' : edge && edge.value > 0 ? 'spread-up' : undefined}>{edge ? <>{formatSigned(edge.value, edge.digits)}（{formatPercent(edge.percent)}）<small>{EXCHANGES[edge.sell]} 卖 · {EXCHANGES[edge.buy]} 买</small></> : '—'}</td></tr>;
      })}
      <tr className="spread-summary"><th scope="row" colSpan={3}>四腿：两所价差之差</th><Value spread={gap} unit="个百分点" /><td /></tr>
    </tbody>
  </table></div>;
}

const shareText = (value: number | null, digits = 3) => value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
/**
 * Anthropic contracts on four venues, converted to one share under the
 * editable share-count assumptions. The gap is conditional on convergence,
 * never a guaranteed return.
 */
function AnthropicTable({ quotes, shares, onShares }: { quotes: ExecutionQuotes; shares: AnthropicShares; onShares: (value: AnthropicShares) => void }) {
  const problem = sharesProblem(shares), books = shareBooks(contract => readBook(quotes, contract.exchange, contract.symbol), shares), pairs = problem ? [] : bestPairs(books);
  return <div className="spread-anthropic">
    <div className="spread-anthropic-shares" role="group" aria-label="Anthropic 股数假设">
      <label>流通股 · 十亿股<input type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={shares.outstanding} onChange={event => onShares({ ...shares, outstanding: event.target.value })} /></label>
      <label>完全稀释股 · 十亿股<input type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={shares.diluted} onChange={event => onShares({ ...shares, diluted: event.target.value })} /></label>
      <button className="button secondary" type="button" disabled={shares.outstanding === DEFAULT_SHARES.outstanding && shares.diluted === DEFAULT_SHARES.diluted} onClick={() => onShares(DEFAULT_SHARES)}>恢复默认 127 亿 / 167 亿</button>
      {problem ? <p className="execution-warning" role="alert">{problem}</p> : <p className="execution-help">默认值为估算，招股书公布正式股数后请修改；下方实盘组合的等股数配腿使用同一组假设。</p>}
    </div>
    <div className="execution-table-wrap"><table className="execution-progress-table spread-table">
      <caption>Anthropic 上市前合约 · 按股数假设折算为每股价格</caption>
      <thead><tr><th scope="col">合约</th><th scope="col">买一 / 卖一<small>原生报价</small></th><th scope="col">每单位折合<small>股</small></th><th scope="col">每股 买 / 卖<small>USD</small></th><th scope="col">隐含流通市值<small>十亿 USD</small></th></tr></thead>
      <tbody>{books.map(book => <tr key={`${book.contract.exchange}:${book.contract.symbol}`}><th scope="row">{book.contract.label}</th><td><Quote read={book.read} /></td><td>{shareText(book.perUnit, 2)}</td>
        <td className={book.stale ? 'spread-stale' : undefined}>{shareText(book.bid)} / {shareText(book.ask)}</td><td className={book.stale ? 'spread-stale' : undefined}>{book.mid === null ? '—' : shareText(book.mid * Number(shares.outstanding), 0)}</td></tr>)}</tbody>
    </table></div>
    {pairs.length ? <div className="execution-table-wrap"><table className="execution-progress-table spread-table">
      <caption>两两组合 · 买入便宜一侧卖一、卖出较贵一侧买一</caption>
      <thead><tr><th scope="col">做多</th><th scope="col">做空</th><th scope="col">每股可成交价差<small>占做多成本</small></th><th scope="col">等股数对冲<small>每 1 单位多头</small></th></tr></thead>
      <tbody>{pairs.map(pair => <tr key={`${pair.long.contract.symbol}-${pair.long.contract.exchange}-${pair.short.contract.exchange}-${pair.short.contract.symbol}`}><th scope="row">{pair.long.contract.label}</th><td>{pair.short.contract.label}</td>
        <td className={pair.stale ? 'spread-stale' : pair.gap > 0 ? 'spread-up' : 'spread-down'}>{formatPercent(pair.gap, 2)}</td><td>{shareText(pair.ratio, 4)} 单位空头</td></tr>)}</tbody>
    </table></div> : null}
    <p className="execution-help">价差只在两侧最终按相同每股价格结算时才会收敛，不是保证收益；未计手续费、资金费、逐仓保证金与 USDC / USDT 差异，股数假设变化会直接改变折算结果。</p>
  </div>;
}

function TradingSpread({ pair, shares, onShares }: { pair: TradingPair; shares: AnthropicShares; onShares: (value: AnthropicShares) => void }) {
  const exchanges = pairExchanges(pair);
  const [quotes, setQuotes] = useState<ExecutionQuotes | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [, setClock] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setReading(true);
    try {
      const value = await api<ExecutionQuotes>('/api/trading/execution/quotes', { signal: current.signal, timeoutMs: 12_000 });
      if (current.signal.aborted) return;
      setQuotes(value); setReceivedAt(Date.now()); setError('');
    } catch (reason) {
      if (current.signal.aborted) return;
      setError(reason instanceof ApiError && reason.status === 401 ? '登录已过期，请重新登录。' : reason instanceof Error ? reason.message : '行情读取失败');
    } finally { if (controller.current === current) { controller.current = null; setReading(false); } }
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
    // A slow read is not aborted by the next tick; only a manual refresh replaces it.
    const tick = () => { if (disposed) return; if (!document.hidden && !controller.current) void load(); timer = setTimeout(tick, POLL_MS); };
    const wake = () => { if (!document.hidden && !disposed) { clearTimeout(timer); tick(); } };
    const clock = setInterval(() => setClock(value => value + 1), POLL_MS);
    tick();
    document.addEventListener('visibilitychange', wake);
    return () => { disposed = true; clearTimeout(timer); clearInterval(clock); controller.current?.abort(); document.removeEventListener('visibilitychange', wake); };
  }, [load]);
  const stale = quotes !== null && Date.now() - receivedAt > STALE_MS;
  const markets = ['oil', 'hynix'] as const;
  return <section className="trading-panel spread-panel" aria-labelledby="spread-title">
    <header className="trading-panel-heading"><div><h2 id="spread-title">实时价差</h2><p>Binance / Bybit / OKX / Hyperliquid 盘口买一 / 卖一 · 价差按中间价计算</p></div><button className="button secondary" type="button" disabled={reading} onClick={() => void load()}><RefreshCw size={15} className={reading ? 'spin' : ''} />刷新行情</button></header>
    <div className={`execution-sync${stale || error ? ' stale' : ''}`} role="status"><Clock3 size={14} /><span>{error ? `行情读取失败：${error}${quotes ? ' 当前保留上次结果。' : ''}` : stale ? '行情已过期，正在重新读取。' : quotes ? '前台每 3 秒更新盘口。' : '正在读取盘口…'}{quotes ? ` 最近取得：${time(quotes.generatedAt)}（北京时间）` : ''}</span></div>
    {quotes ? <>
      <div className="spread-markets">{markets.map(market => <VenueTable key={market} market={market} quotes={quotes} />)}</div>
      <details className="spread-section" open><summary>Anthropic 上市前价差 · Hyperliquid（Entropy / trade.xyz）、Binance、OKX</summary><AnthropicTable quotes={quotes} shares={shares} onShares={onShares} /></details>
      <details className="spread-cross"><summary>跨所价差 · {exchanges.map(exchange => EXCHANGES[exchange]).join(' 与 ')}</summary>
        <div className="spread-markets">{markets.map(market => <CrossTable key={market} market={market} quotes={quotes} pair={exchanges} />)}</div>
      </details>
    </> : null}
  </section>;
}

export default memo(TradingSpread);
