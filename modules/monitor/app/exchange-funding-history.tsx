"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { RefreshCw, X } from "lucide-react";
import { exchangeDefinition, exchangeNames, type Exchange } from "../lib/exchange-quotes";
import { exchangeFundingAction, HISTORY_PAGE_SIZE, HISTORY_REFRESH_MS, HISTORY_STALE_MS, HISTORY_WINDOW_MS, validateExchangeFundingHistory, type ExchangeFundingHistory } from "../lib/exchange-funding-history";
import { analyzeFundingRange, fundingRangeInput, parseFundingRangeInput } from "../lib/exchange-funding-analysis";
import { summaryTimestamp } from "../lib/monitor-summary";
import { startActivityPolling } from "../lib/polling";

export type FundingHistorySelection = { exchange: Exchange; direction: "short" | "long" };
type HistoryCache = Partial<Record<Exchange, ExchangeFundingHistory>>;
type FundingSide = "left" | "right";
type RangeSelection = { days: 7 | 30 | 60 } | { from: number; to: number };
const dayMs = 24 * 3_600_000;
const minuteMs = 60_000;
const rateNumber = new Intl.NumberFormat("en-US", { minimumFractionDigits: 5, maximumFractionDigits: 8, useGrouping: false });
const formatRate = (rate: number) => {
  const magnitude = Math.abs(rate * 100);
  const value = magnitude > 0 && magnitude < 1e-8 ? magnitude.toExponential(4).replace(/\.?(0+)(?=e)/, "") : rateNumber.format(magnitude);
  return `${rate > 0 ? "+" : rate < 0 ? "−" : ""}${value}%`;
};

export default function ExchangeFundingHistoryPanel({ id, selection, active, now, onClose }: {
  id: string;
  selection: FundingHistorySelection | null;
  active: boolean;
  now: number;
  onClose: () => void;
}) {
  const [histories, setHistories] = useState<HistoryCache>({});
  const [errors, setErrors] = useState<Partial<Record<Exchange, string>>>({});
  const [refreshingExchange, setRefreshingExchange] = useState<Exchange | null>(null);
  const [rangeSelection, setRangeSelection] = useState<RangeSelection>({ days: 60 });
  const [rangeDraft, setRangeDraft] = useState<{ from: string; to: string } | null>(null);
  const [rangeError, setRangeError] = useState("");
  const [pages, setPages] = useState({ key: "", left: 1, right: 1 });
  const latest = useRef<HistoryCache>({});
  const poll = useRef<ReturnType<typeof startActivityPolling> | null>(null);
  const panel = useRef<HTMLElement>(null);
  const tables = useRef<Partial<Record<FundingSide, HTMLDivElement | null>>>({});
  const exchange = selection?.exchange ?? null;
  const direction = selection?.direction;
  const history = exchange ? histories[exchange] : undefined;
  const referenceTime = history ? Math.max(history.left.coverage?.to ?? 0, history.right.coverage?.to ?? 0) || Date.parse(history.fetchedAt) : now;
  // Round shortcuts inward to whole minutes so every displayed minute has been queried.
  const from = "days" in rangeSelection ? Math.ceil((referenceTime - rangeSelection.days * dayMs) / minuteMs) * minuteMs : rangeSelection.from;
  const to = "days" in rangeSelection ? Math.floor(referenceTime / minuteMs) * minuteMs : rangeSelection.to;
  const analysis = useMemo(() => history && direction ? analyzeFundingRange(history, { from, to }, direction) : null, [history, from, to, direction]);
  const pageKey = `${exchange}:${from}:${to}`;
  const draft = rangeDraft ?? { from: fundingRangeInput(from), to: fundingRangeInput(to) };

  useEffect(() => {
    if (!exchange || !active) return;
    const cached = latest.current[exchange];
    const control = startActivityPolling({
      intervalMs: HISTORY_REFRESH_MS,
      immediate: !cached || cached.status === "snapshot" || Date.now() - Date.parse(cached.fetchedAt) >= HISTORY_REFRESH_MS,
      async load(signal) {
        const response = await fetch(`/api/monitors/oil/${exchangeFundingAction(exchange)}`, { cache: "no-store", signal });
        if (!response.ok) throw new Error(response.status === 423 ? "原油监控已暂停。" : "历史结算读取失败，稍后重试。已有记录保留。");
        try { return validateExchangeFundingHistory(await response.json(), exchange); }
        catch { throw new Error("历史结算数据异常，已有记录保留。"); }
      },
      onData(value) {
        const previous = latest.current[exchange];
        if (previous && Date.parse(value.fetchedAt) < Date.parse(previous.fetchedAt)) {
          setErrors(current => ({ ...current, [exchange]: "收到较旧历史，保留已有记录。" }));
          return;
        }
        latest.current[exchange] = value;
        setHistories(current => ({ ...current, [exchange]: value }));
        setErrors(current => ({ ...current, [exchange]: "" }));
      },
      onError(error) {
        setErrors(current => ({ ...current, [exchange]: error instanceof Error ? error.message : "历史结算暂不可用。" }));
      },
    });
    poll.current = control;
    return () => { control.stop(); poll.current = null; };
  }, [exchange, active]);

  useEffect(() => {
    if (!exchange || !active) return;
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [exchange, direction, active]);

  if (!selection) return null;
  const error = errors[selection.exchange];
  const definition = exchangeDefinition(selection.exchange, "oil");
  const unavailable = history?.availability === "unsupported";
  const loading = !history && !error;
  const refreshing = refreshingExchange === selection.exchange;
  const stale = Boolean(history && (history.status === "snapshot" || Date.parse(history.fetchedAt) < now - HISTORY_STALE_MS || error));
  async function refresh() {
    if (!exchange || !poll.current) return;
    setRefreshingExchange(exchange);
    try { await poll.current.refresh(); }
    finally { setRefreshingExchange(current => current === exchange ? null : current); }
  }
  function applyRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const start = parseFundingRangeInput(draft.from), end = parseFundingRangeInput(draft.to);
    if (start === null || end === null || start >= end) {
      setRangeError("请输入有效的北京时间，结束时间需晚于开始时间。");
      return;
    }
    if (end - start > HISTORY_WINDOW_MS) {
      setRangeError("区间最长为 60 天，请缩小起止范围。");
      return;
    }
    setRangeSelection({ from: start, to: end });
    setRangeDraft(null);
    setRangeError("");
  }
  function chooseDays(days: 7 | 30 | 60) {
    setRangeSelection({ days });
    setRangeDraft(null);
    setRangeError("");
  }
  function changePage(side: FundingSide, page: number) {
    setPages(current => ({ ...(current.key === pageKey ? current : { key: pageKey, left: 1, right: 1 }), [side]: page }));
    tables.current[side]?.scrollTo({ top: 0 });
  }

  return <section id={id} ref={panel} className="exchange-funding-history" aria-labelledby={`${id}-title`} aria-busy={loading || refreshing} tabIndex={-1} data-funding-exchange={selection.exchange}>
    <div className="exchange-funding-heading">
      <div><h3 id={`${id}-title`}>{exchangeNames[selection.exchange]} · 资金费结算历史</h3><p>{selection.direction === "short" ? "做空价差：空布伦特、多 WTI" : "做多价差：多布伦特、空 WTI"} · {history?.currency ?? definition.currency}</p></div>
      <div className="exchange-funding-actions">
        {!unavailable && <button type="button" className="refresh-button" onClick={refresh} disabled={loading || refreshing || !active} aria-label={`刷新 ${exchangeNames[selection.exchange]} 资金费历史`}><RefreshCw size={14} className={refreshing ? "spinning" : ""}/>{refreshing ? "更新中" : "刷新"}</button>}
        <button type="button" className="exchange-funding-close" onClick={onClose} aria-label="收起资金费历史"><X size={18}/><span>收起</span></button>
      </div>
    </div>
    <p className="exchange-funding-note">保留最近 60 天实际结算，每腿每页 200 次，按时间倒序。累计包含所选区间全部已取得记录；正费率表示多头付款、空头收款。</p>
    <div className="exchange-funding-status" role="status">
      {loading ? <p>正在读取结算记录…</p> : null}
      {error ? <p className="exchange-stale">{error}</p> : null}
      {history && !unavailable ? <p className={stale ? "exchange-stale" : ""}>{stale ? "保留历史 · 待更新" : history.left.error || history.right.error ? "部分记录待更新" : "已更新"} · 采集于 <time dateTime={history.fetchedAt}>{summaryTimestamp(history.fetchedAt)}</time> 北京时间</p> : null}
      {history?.reason ? <p>{history.reason}</p> : null}
    </div>
    {!unavailable && history && analysis ? <>
      <form className="exchange-funding-range" onSubmit={applyRange} noValidate aria-label="资金费统计区间">
        <div className="exchange-funding-presets" aria-label="快捷区间">{([7, 30, 60] as const).map(days => <button key={days} type="button" aria-pressed={"days" in rangeSelection && rangeSelection.days === days} onClick={() => chooseDays(days)}>最近 {days} 天</button>)}</div>
        <div className="exchange-funding-range-fields">
          <label htmlFor={`${id}-range-from`}>开始（北京时间）<input id={`${id}-range-from`} type="datetime-local" step="60" value={draft.from} aria-invalid={Boolean(rangeError)} aria-describedby={`${id}-range-help${rangeError ? ` ${id}-range-error` : ""}`} onChange={event => setRangeDraft({ ...draft, from: event.target.value })}/></label>
          <label htmlFor={`${id}-range-to`}>结束（北京时间，不含）<input id={`${id}-range-to`} type="datetime-local" step="60" value={draft.to} aria-invalid={Boolean(rangeError)} aria-describedby={`${id}-range-help${rangeError ? ` ${id}-range-error` : ""}`} onChange={event => setRangeDraft({ ...draft, to: event.target.value })}/></label>
          <button type="submit" className="exchange-funding-apply">应用区间</button>
        </div>
        <p id={`${id}-range-help`}>按北京时间统计，包含开始、不含结束。累计为费率简单相加，不复利，不代表实际金额或两腿组合收益。</p>
        {rangeError ? <p id={`${id}-range-error`} className="exchange-stale" role="alert">{rangeError}</p> : null}
      </form>
      <p className="exchange-funding-selected-range">当前统计：{fundingRangeInput(from).replace("T", " ")} 至 {fundingRangeInput(to).replace("T", " ")}（北京时间，结束不含）</p>
      <div className="exchange-funding-legs">{(["left", "right"] as const).map(side => {
      const leg = history[side], short = side === "left" ? selection.direction === "short" : selection.direction === "long";
      const result = analysis[side];
      const pageCount = Math.max(1, Math.ceil(result.count / HISTORY_PAGE_SIZE));
      const page = Math.min(pageCount, pages.key === pageKey ? pages[side] : 1);
      const records = result.records.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE);
      const name = side === "left" ? "布伦特" : "WTI";
      const legStale = Boolean(leg.fetchedAt && now - Date.parse(leg.fetchedAt) > HISTORY_STALE_MS);
      return <article key={side} className="exchange-funding-leg" data-funding-leg={side}>
        <h4>{name} · {short ? "做空" : "做多"}<span>{leg.symbol}</span></h4>
        {leg.error ? <p className="exchange-stale">{leg.error}</p> : null}
        {leg.fetchedAt ? <p className={legStale ? "exchange-stale" : ""}>{legStale ? "保留历史 · " : ""}采集于 {summaryTimestamp(leg.fetchedAt)} 北京时间</p> : null}
        <dl className="exchange-funding-totals" aria-label={`${name}区间累计`}>
          <div><dt>原始费率累计</dt><dd data-funding-total="raw">{result.rawRate === null ? "—" : formatRate(result.rawRate)}</dd></div>
          <div><dt>本方向收付累计</dt><dd data-funding-total="position" className={result.positionRate !== null && result.positionRate > 0 ? "positive" : result.positionRate !== null && result.positionRate < 0 ? "negative" : ""}>{result.positionRate === null ? "—" : formatRate(result.positionRate)}</dd></div>
          <div><dt>结算次数</dt><dd data-funding-total="count">{result.count.toLocaleString()}</dd></div>
        </dl>
        <p className={result.coverage === "queried" ? "exchange-funding-coverage" : "exchange-funding-coverage exchange-stale"} data-funding-coverage={result.coverage}>{result.coverage === "queried" ? "所选区间已查询 · 收付累计正值收款、负值付款" : result.coverage === "partial" ? "已取得记录累计 · 所选范围未完全覆盖" : "已取得记录累计 · 查询覆盖范围未知"}</p>
        {records.length ? <>
          <div className="exchange-funding-table-scroll" ref={element => { tables.current[side] = element; }} tabIndex={0} role="region" aria-label={`${name}结算记录，第 ${page} 页`}><table className="exchange-funding-table"><thead><tr><th scope="col">结算时间（北京时间）</th><th scope="col">实际费率</th><th scope="col">本方向</th></tr></thead><tbody>{records.map(row => {
          const cashflow = short ? row.rate : -row.rate;
          const timestamp = new Date(row.time).toISOString();
          return <tr key={row.time}><td><time dateTime={timestamp} title={timestamp}>{summaryTimestamp(timestamp)}</time></td><td>{formatRate(row.rate)}</td><td className={cashflow > 0 ? "positive" : cashflow < 0 ? "negative" : ""}>{cashflow > 0 ? "收取" : cashflow < 0 ? "支付" : "零费率"}</td></tr>;
          })}</tbody></table></div>
          <nav className="exchange-funding-pagination" aria-label={`${name}结算记录分页`}>
            <span role="status">第 {page} / {pageCount} 页 · 共 {result.count.toLocaleString()} 次</span>
            <div><button type="button" disabled={page === 1} aria-label={`${name}上一页`} onClick={() => changePage(side, page - 1)}>上一页</button><button type="button" disabled={page === pageCount} aria-label={`${name}下一页`} onClick={() => changePage(side, page + 1)}>下一页</button></div>
          </nav>
        </> : <p className="exchange-funding-empty">所选区间暂无可用结算记录。</p>}
      </article>;
      })}</div>
    </> : null}
  </section>;
}
