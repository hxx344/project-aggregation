"use client";

import { Fragment, memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { lazyComponent } from "../lib/lazy-component";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { calculateExchangeSpread, displayComparisonExchanges, exchangeContracts, exchangeDefinition, exchangeNames, externalQuoteStale, type Exchange, type ExchangeLeg, type ExchangeQuote, type ExternalQuoteSet, type SpreadMarket } from "../lib/exchange-quotes";
import { useExchangeQuotes } from "../hooks/use-exchange-quotes";
import { summaryTimestamp } from "../lib/monitor-summary";
import { startActivityPolling } from "../lib/polling";
import ExchangeFundingHistoryPanel, { type FundingHistorySelection } from "./exchange-funding-history";
import VariationalSession from "./variational-session";

const OilFundingHedge = lazyComponent(() => import("./oil-funding-hedge"), { clientOnly: true, loading: () => <p className="exchange-caption" role="status">正在载入四腿历史模拟…</p> });

const signed = (value: number | null | undefined, digits = 2, suffix = "") => { if (value == null) return "—"; const rounded = Number(value.toFixed(digits)); return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(digits)}${suffix}`; };
const tone = (value: number | null | undefined) => value == null || value === 0 ? "" : value > 0 ? "positive" : "negative";
const price = (value: number | undefined, digits: number) => value === undefined ? "—" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const rate = (value: number | null) => signed(value === null ? null : value * 100, 5, "%");
const fundingPriceLabels = { oracle: "预言机价格", index: "指数价格", mark: "标记价格" };
const settlement = (leg: ExchangeLeg) => leg.nextFundingAt ? `${summaryTimestamp(leg.nextFundingAt)}${leg.nextFundingEstimated ? "（推算）" : ""}` : "—";

function ExchangeComparison({ monitorId, primary, initial, renderedAt, active = true, interactionActive = active }: { monitorId: SpreadMarket; primary?: ExchangeQuote; initial?: ExternalQuoteSet; renderedAt?: number; active?: boolean; interactionActive?: boolean }) {
  const { quotes, errors, loading, refresh } = useExchangeQuotes(monitorId, initial, active);
  const [now, setNow] = useState(() => renderedAt ?? Date.now());
  const [historySelection, setHistorySelection] = useState<FundingHistorySelection | null>(null);
  const historyId = useId();
  const historyTrigger = useRef<HTMLButtonElement | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const sessionId = useId();
  const sessionTrigger = useRef<HTMLButtonElement | null>(null);
  const closeSession = useCallback(() => { setSessionOpen(false); if (!document.hidden) sessionTrigger.current?.focus({ preventScroll: true }); }, []);
  const contracts = exchangeContracts[monitorId], oil = monitorId === "oil";
  function selectHistory(exchange: Exchange, direction: FundingHistorySelection["direction"], trigger: HTMLButtonElement) {
    historyTrigger.current = trigger;
    setHistorySelection(current => current?.exchange === exchange && current.direction === direction ? null : { exchange, direction });
  }
  function closeHistory() {
    setHistorySelection(null);
    historyTrigger.current?.focus({ preventScroll: true });
    historyTrigger.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }
  useEffect(() => {
    if (!active) return;
    const clock = startActivityPolling({ intervalMs: 5000, load: async () => Date.now(), onData: setNow, onError: () => {} });
    return () => clock.stop();
  }, [active]);
  const rows = displayComparisonExchanges(monitorId).map(exchange => {
    const definition = exchangeDefinition(exchange, monitorId);
    const secondary = quotes[exchange];
    const quote = primary?.exchange === exchange && (!secondary || Date.parse(primary.fetchedAt) >= Date.parse(secondary.fetchedAt)) ? primary : secondary;
    const error = errors[exchange];
    const stale = Boolean(quote && (error || externalQuoteStale(quote, now)));
    return { exchange, definition, quote, error, metrics: quote ? calculateExchangeSpread(quote) : null, stale, status: !quote ? error ? "暂不可用" : "等待首次采集" : stale ? "保留数据 · 待更新" : quote.fundingError ? "价格已更新 · 资金费缺失" : "已更新" };
  });
  return <section className="exchange-comparison" aria-label={`${oil ? "原油" : "海力士"}交易所实时对比`} data-exchange-market={monitorId}>
    <div className="exchange-heading"><div><h2>交易所实时对比</h2><p>{oil ? "价差相对 WTI · 资金费按等桶数" : "ADR − 正股 ÷ 10 · 10 份 ADR 对 1 股正股"}</p></div><div><span>{oil ? "各平台每 15 秒更新" : "Bybit / Binance 每 15 秒更新"}</span><button type="button" className="refresh-button" onClick={refresh} disabled={loading} aria-label={`刷新${oil ? "原油" : "海力士"}交易所报价`}><RefreshCw size={14} className={loading ? "spinning" : ""}/>{loading ? "更新中" : "刷新"}</button></div></div>
    <Table className="exchange-table">
      <TableHeader><TableRow><TableHead>交易所 / 报价口径</TableHead><TableHead>{contracts.leftLabel} / {oil ? "WTI" : "正股 ÷ 10"}</TableHead><TableHead>{oil ? "价差 (%)" : "价差"}</TableHead>{!oil && <TableHead>ADR 溢价率</TableHead>}<TableHead>做空价差年化</TableHead><TableHead>做多价差年化</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map(({ exchange, definition, quote, metrics, stale, status }) => <Fragment key={exchange}><TableRow data-exchange={exchange} data-stale={stale}>
        <TableCell className="exchange-identity"><strong>{exchangeNames[exchange]}</strong><span>{quote?.currency ?? definition.currency} · {(quote?.priceBasis ?? definition.priceBasis) === "mid" ? "中间价" : "标记价"}</span><small className={stale || !quote || quote.fundingError ? "exchange-stale" : ""}>{status}</small>{quote && <time dateTime={quote.fetchedAt}>{quote.timestampBasis === "received" ? "采集时间：" : ""}{summaryTimestamp(quote.fetchedAt)} 北京时间</time>}{quote?.timestampBasis === "received" && <small>源未提供行情时间戳</small>}{quote?.fundingError && <small className="exchange-stale">{quote.fundingError}</small>}{oil && exchange === "variational" ? <button ref={sessionTrigger} type="button" className="variational-session-trigger" onClick={() => setSessionOpen(open => !open)} aria-expanded={sessionOpen && interactionActive} aria-controls={sessionId}>更新 Var token<ChevronDown size={13} aria-hidden="true"/></button> : null}</TableCell>
        <TableCell data-label={`${contracts.leftLabel} / ${oil ? "WTI" : "正股 ÷ 10"}`}><span className="exchange-prices"><span>{price(quote?.left.price, oil ? 3 : 2)}</span><span className="exchange-separator" aria-hidden="true">/</span><span>{price(metrics?.equivalent, oil ? 3 : 2)}</span></span><small className="exchange-pair-symbols">{quote ? `${quote.left.symbol} / ${quote.right.symbol}` : `${definition.left} / ${definition.right}`}</small></TableCell>
        <TableCell data-label={oil ? "价差 (%)" : "价差"}><strong className={tone(oil ? metrics?.premium : metrics?.spread)}>{signed(oil ? metrics?.premium : metrics?.spread, oil ? 3 : 2, oil ? "%" : "")}</strong></TableCell>
        {!oil && <TableCell data-label="ADR 溢价率"><strong className={tone(metrics?.premium)}>{signed(metrics?.premium, 2, "%")}</strong></TableCell>}
        <TableCell data-label="做空价差年化">{oil ? <button type="button" className={`exchange-funding-trigger ${tone(metrics?.shortAnnualized)}`} onClick={event => selectHistory(exchange, "short", event.currentTarget)} aria-label={`查看 ${exchangeNames[exchange]} 做空价差的资金费结算历史`} aria-expanded={historySelection?.exchange === exchange && historySelection.direction === "short"} aria-controls={historyId}><strong>{signed(metrics?.shortAnnualized == null ? null : metrics.shortAnnualized * 100, 2, "%")}</strong><ChevronDown size={13} aria-hidden="true"/></button> : <strong className={tone(metrics?.shortAnnualized)}>{signed(metrics?.shortAnnualized == null ? null : metrics.shortAnnualized * 100, 2, "%")}</strong>}</TableCell>
        <TableCell data-label="做多价差年化">{oil ? <button type="button" className={`exchange-funding-trigger ${tone(metrics?.longAnnualized)}`} onClick={event => selectHistory(exchange, "long", event.currentTarget)} aria-label={`查看 ${exchangeNames[exchange]} 做多价差的资金费结算历史`} aria-expanded={historySelection?.exchange === exchange && historySelection.direction === "long"} aria-controls={historyId}><strong>{signed(metrics?.longAnnualized == null ? null : metrics.longAnnualized * 100, 2, "%")}</strong><ChevronDown size={13} aria-hidden="true"/></button> : <strong className={tone(metrics?.longAnnualized)}>{signed(metrics?.longAnnualized == null ? null : metrics.longAnnualized * 100, 2, "%")}</strong>}</TableCell>
      </TableRow>{oil && exchange === "variational" && sessionOpen && interactionActive ? <TableRow className="variational-session-row"><TableCell colSpan={5}><VariationalSession id={sessionId} now={now} onClose={closeSession} onSaved={refresh}/></TableCell></TableRow> : null}</Fragment>)}</TableBody>
    </Table>
    <p className="exchange-caption">正值收款，负值付款；按当前费率简单年化，以两腿总名义金额为分母。{oil ? "做空：空布伦特、多 WTI；做多反向。点击年化可查看最近实际结算。" : "做空：空 ADR、多正股；做多反向。"}</p>
    {oil ? <ExchangeFundingHistoryPanel id={historyId} selection={historySelection} active={active} now={now} onClose={closeHistory}/> : null}
    <details className="exchange-details"><summary>资金费周期与计算口径</summary><div className="exchange-details-body">
      {rows.map(({ exchange, quote, error }) => <article key={exchange}><strong>{exchangeNames[exchange]}</strong>{quote ? <><p>{quote.left.symbol}：{rate(quote.left.fundingRate)} / {quote.left.fundingIntervalHours ?? "—"} 小时；{quote.right.symbol}：{rate(quote.right.fundingRate)} / {quote.right.fundingIntervalHours ?? "—"} 小时。</p>{quote.fundingFetchedAt && <p>资金费名义金额使用{fundingPriceLabels[quote.fundingPriceBasis]}。</p>}{quote.fundingFetchedAt && <p>资金费采集：{summaryTimestamp(quote.fundingFetchedAt)} 北京时间。</p>}<p>下次结算：{contracts.leftLabel} {settlement(quote.left)}；{contracts.rightLabel} {settlement(quote.right)} 北京时间。</p>{quote.fundingError && <p className="exchange-stale">{quote.fundingError}</p>}</> : <p>尚未取得有效报价。</p>}{error && <p className="exchange-stale">{error}</p>}</article>)}
      {rows.some(row => row.exchange === "variational" && row.quote?.fundingFetchedAt) ? <p>Variational 按当前标记价估算两腿名义金额；展示为当前费率预估，并非实际结算金额。</p> : null}
      <p>净年化 =（空腿名义 × 空腿费率 ÷ 空腿周期小时 − 多腿名义 × 多腿费率 ÷ 多腿周期小时）÷ 两腿总名义 × 8,760。各腿按各自周期换算；费率或周期缺失时显示“—”，不按零费率计算。</p>
      <p>{oil ? "原油价差 =（布伦特价格 − WTI 价格）÷ WTI 价格 × 100%。USD、USDT 与 USDC 分别标注，不假定彼此严格等值。" : "ADR 溢价率 =（ADR 价格 ÷（正股价格 ÷ 10）− 1）× 100%。USDT 接口报价已完成币种换算，不额外换算韩元；USD 与 USDT 不假定严格等值。"}各行只计算同一交易所内的两腿。{!oil && "Hyperliquid 沿用当前中间价，另两家使用标记价。"}</p>
      <p>本区为当前费率预估，实际结算费率可能变化。下方历史图表及告警使用 {oil ? 'Binance' : 'Hyperliquid'}。</p>
      <div className="exchange-source-links"><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding" target="_blank" rel="noreferrer">Hyperliquid 规则 ↗</a><a href="https://www.bybit.com/en/help-center/article/Funding-fee-calculation" target="_blank" rel="noreferrer">Bybit 规则 ↗</a><a href="https://www.binance.com/en/support/faq/detail/360033525031" target="_blank" rel="noreferrer">Binance 规则 ↗</a>{oil && <><a href="https://docs.lighter.xyz/trading/funding" target="_blank" rel="noreferrer">Lighter 规则 ↗</a><a href="https://docs.variational.io/technical-documentation/api" target="_blank" rel="noreferrer">Variational 接口说明 ↗</a><a href="https://www.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate" target="_blank" rel="noreferrer">OKX 资金费接口 ↗</a><a href="https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market" target="_blank" rel="noreferrer">Bitget 资金费接口 ↗</a></>}</div>
    </div></details>
    {oil ? <OilFundingHedge active={active} now={now}/> : null}
  </section>;
}

export default memo(ExchangeComparison);
