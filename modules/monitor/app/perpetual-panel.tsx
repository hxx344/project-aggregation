"use client";

import { hubNavigate, cleanHubQuery } from "../lib/hub-bridge";
import { Fragment, Suspense, lazy, memo, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, Bell, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search, SlidersHorizontal, Star, X } from "lucide-react";
import { usePerpetualFeed } from "../hooks/use-perpetual-feed";
import { usePerpetualQuality } from "../hooks/use-perpetual-quality";
import { usePerpetualFundingHistory } from "../hooks/use-perpetual-funding-history";
import { usePerpetualMarketMetrics } from "../hooks/use-perpetual-market-metrics";
import { usePerpetualScannerData } from "../hooks/use-perpetual-scanner-data";
import { createScannerDataPairSelector, scannerDataHistoryForPair } from "../lib/perpetual-scanner-data";
import { nextScannerSort, parseScannerSort, scannerSortRequirements, sortScannerRows, type ScannerSort, type ScannerSortColumn } from "../lib/perpetual-scanner-sort";
import { fundingWindowTotal, type PerpetualFundingLeg } from "../lib/perpetual-funding-history";
import { usePerpetualFx } from "../hooks/use-perpetual-fx";
import PerpetualCrossExSettings from "./perpetual-crossex-settings";
import PerpetualPushToggle from "./perpetual-push-toggle";
import { usePerpetualCrossExSettings, type PerpetualCrossExController } from "../hooks/use-perpetual-crossex-settings";
import { filterCrossExRanking, spotTransferPairEvidence, spotTransferPairState } from "../lib/perpetual-crossex-eligibility";
import PerpetualFeeSettings from "./perpetual-fee-settings";
import { defaultQualityBudget, evaluateOpportunityQuality, pairQualityHistory, parseQualityBudget, qualityPairKey, type OpportunityQuality, type PerpetualQualityReport } from "../lib/perpetual-quality";
import { estimatePerpetualHoldingScenario } from "../lib/perpetual-opportunity";
import { classifyPerpetualQuote, createPerpetualQuoteSelector, createPerpetualRankingSelector, defaultPerpetualFilters, normalizedFunding8h, parsePerpetualPreferences, perpetualSpreadKey, quotePriceTime, visiblePerpetualSnapshot, type PerpetualFilters, type PerpetualSpread } from "../lib/perpetual-spreads";
import type { PerpetualExchange, PerpetualPairMode, PerpetualPriceMode, PerpetualQuote, PerpetualSnapshot } from "../lib/perpetual-types";
import type { SummaryProps } from "../lib/monitor-summary";
import { SCANNER_COLUMNS, SCANNER_CATEGORIES, defaultScannerPreferences, parseScannerPreferences, scannerPairCategory, scannerQuoteCategory, annualizedFundingPercent, type ScannerPreferences, type ScannerCategoryId, type ScannerColumnId } from "../lib/perpetual-scanner";
import { ScannerMenu, ScannerLeg, ScannerFundingRate, ScannerHistory, ScannerMarketMetric, scannerPercent, scannerPolarity } from "./perpetual-scanner-parts";
import { ScannerRangeFilters } from "./perpetual-scanner-filters";
import { compileScannerRanges, evaluateScannerRanges, parseScannerRangeInputs, type ScannerRangeId, type ScannerRangeInputs } from "../lib/perpetual-scanner-filters";
import { perpetualChartUrl, perpetualWorkspaceUrl, readPerpetualChartSelection, type PerpetualChartSelection } from "../lib/perpetual-chart-state";
import "./perpetual.css";
import "./perpetual-scanner.css";

const PerpetualHealth = lazy(() => import("./perpetual-health"));
const PerpetualManualPairs = lazy(() => import("./perpetual-manual-pairs"));
const PerpetualAlerts = lazy(() => import("./perpetual-alerts"));
const PerpetualExecution = lazy(() => import("./perpetual-execution").then(module => ({ default: module.PerpetualExecution })));
const PerpetualHolding = lazy(() => import("./perpetual-holding"));
const PerpetualTrend = lazy(() => import("./perpetual-trend"));
const PerpetualExit = lazy(() => import("./perpetual-exit"));
const PerpetualPaper = lazy(() => import("./perpetual-paper"));
const PerpetualChart = lazy(() => import("./perpetual-chart"));
type DetailTab = "execution" | "quality" | "exit" | "quotes";

const scannerPreferencesKey = "market-monitor:perpetual-scanner:v1";
const scannerRangesKey = "market-monitor:perpetual-scanner-ranges:v1";
const scannerSortKey = "market-monitor:perpetual-scanner-sort:v1";
const sortableScannerColumns = new Set<string>(["fundingSpread", "annualized", "volume", "openInterest", "quote", "spread", "history24h", "history7d", "history30d"]);
const preferencesKey = "market-monitor:perpetual:v1";
const qualityBudgetKey = "market-monitor:perpetual-quality-budget:v1";
const pageSize = 30;
const emptyQuotes: PerpetualQuote[] = [];
const emptyExchanges: PerpetualExchange[] = [];
const emptySpreads: PerpetualSpread[] = [];
const exchangeLabels = { connecting: "连接中", live: "实时", stale: "已过期", error: "连接异常", disabled: "未启用" };
const positioningVenues = [{ id: "binance", name: "Binance" }, { id: "bybit", name: "Bybit" }, { id: "okx", name: "OKX" }, { id: "bitget", name: "Bitget" }, { id: "gate", name: "Gate" }];
const positioningStatusLabels = { fresh: "已纳入", stale: "未纳入", pending: "采集中", unsupported: "不支持", unavailable: "暂无资料", error: "更新失败", "rate-limited": "请求限流" };
const clockFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const delistingFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const stamp = (value: number | null | undefined) => value && Number.isFinite(value) ? clockFormat.format(value) : "—";
const percent = (value: number | null, digits = 3) => value === null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
const age = (time: number, now: number) => `${Math.max(0, Math.floor((now - time) / 1000))} 秒前`;
const priceFormats = [2, 4, 6, 12].map(maximumFractionDigits => new Intl.NumberFormat("en-US", { maximumFractionDigits }));
const usdFormat = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const share = (value: number | null | undefined, digits = 1) => finite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
const usd = (value: number | null | undefined) => finite(value) && value > 0 ? usdFormat.format(value) : "—";
const deviation = (value: number | null | undefined) => finite(value) ? `${value.toFixed(4)} 百分点` : "—";
function price(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  if (value < 0.00000001) return value.toExponential(4);
  return priceFormats[value >= 1000 ? 0 : value >= 1 ? 1 : value >= 0.01 ? 2 : 3].format(value);
}

function pairName(key: string) {
  try { const [base, long, short] = JSON.parse(key) as string[]; return `${base} · 多 ${long} / 空 ${short}`; }
  catch { return key; }
}

const fundingHistoryStatus = { pending: "采集中", partial: "历史不足", stale: "已过期", error: "更新失败", unsupported: "不支持", ready: "" };
function FundingHistory({ long, short, now }: { long: PerpetualFundingLeg | undefined; short: PerpetualFundingLeg | undefined; now: number }) {
  const windows = ([24, 72, 168, 720] as const).map(hours => fundingWindowTotal(long, short, hours, now));
  const asOf = windows[0].asOf;
  return <div className="perp-funding-history" aria-label="历史已结算资金费累计">
    <dl>{windows.map(window => <div key={window.hours} data-history-hours={window.hours}>
      <dt>过去 {window.hours / 24} 天</dt><dd className={window.netPercent !== null && window.netPercent < 0 ? "negative" : window.netPercent !== null && window.netPercent > 0 ? "positive" : ""}>{percent(window.netPercent, 4)}</dd>
      {window.status !== "ready" ? <small title={window.reason}>{fundingHistoryStatus[window.status]}</small> : null}
    </div>)}</dl>
    <small className="perp-funding-history-time">{asOf === null ? "等待历史结算" : <>截止 <time dateTime={new Date(asOf).toISOString()}>{delistingFormat.format(asOf)}</time></>}</small>
    <details><summary>双腿累计与次数</summary>{windows.map(window => <div key={window.hours} className="perp-funding-history-evidence">
      <strong>过去 {window.hours / 24} 天</strong>
      <span>多腿费率累计 {percent(window.longPercent, 4)} · {window.longCount} 次</span>
      <span>空腿费率累计 {percent(window.shortPercent, 4)} · {window.shortCount} 次</span>
      {window.reason ? <small>{window.reason}</small> : null}
    </div>)}<p>净累计 = 空腿 − 多腿；按单腿等名义本金，不复利、不含交易成本，不代表账户实赚。截止时间为北京时间。</p></details>
  </div>;
}

function SpotTransferEvidence({ row, settings, now }: { row: PerpetualSpread; settings: PerpetualCrossExController; now: number }) {
  const state = spotTransferPairState(row, settings.error ? null : settings.data, settings.spotTransferPairs, now);
  const evidence = spotTransferPairEvidence(row, settings.spotTransferPairs);
  if (state !== "verified") return <small>现货充提：{state === "disabled" ? "未启用" : state === "expired" ? "证据已过期" : "未知 / 无法核验"}</small>;
  return <><small>双边现货 · 双向充提正常</small><small>共同网络 {evidence!.networks.join(" / ")}</small><small>核验 {stamp(evidence!.checkedAt)} · 到期 {stamp(evidence!.expiresAt)}</small></>;
}

function DelistingNotice({ quote, now }: { quote: PerpetualQuote; now: number }) {
  if (!quote.delisting) return null;
  const at = typeof quote.delistingAt === "number" && Number.isFinite(quote.delistingAt) && quote.delistingAt > 0 ? quote.delistingAt : null;
  const due = at !== null && now >= at;
  return <div className={`perp-delisting${due ? " is-due" : ""}`}>
    <span className="perp-delisting-label">{due ? "已到下架时间" : "即将下架"}</span>
    <span className="perp-delisting-time">{at === null ? "下架时间待公布" : <><time dateTime={new Date(at).toISOString()}>{delistingFormat.format(at)}</time> <span className="perp-delisting-zone">北京时间</span></>}</span>
  </div>;
}

function QualityCell({ quality, pairLabel, onInspect }: { quality: OpportunityQuality; pairLabel: string; onInspect: () => void }) {
  return <button type="button" className={`perp-quality-grade ${quality.grade}`} aria-label={`查看 ${pairLabel} 聚合质量依据：${quality.label}${quality.score === null ? "" : `，${quality.score} 分`}，数据覆盖 ${quality.coverage}%`} onClick={onInspect}>
    <strong>{quality.label}<b>{quality.score === null ? "—" : quality.score}<small>{quality.score === null ? "" : "/100"}</small></b></strong>
    <span>数据覆盖 {quality.coverage}%</span>
    <span className="perp-quality-signals">{Object.entries(quality.profiles).map(([key, profile]) => <span key={key} className={profile.status} title={profile.detail}>{profile.label}</span>)}</span>
  </button>;
}

function PositioningOverviewCard({ base, report, venues, now }: { base: string; report: PerpetualQualityReport | null; venues: Map<string, PerpetualExchange>; now: number }) {
  const overview = report?.positioningOverview?.[base];
  const stale = Boolean(overview?.observedAt && now - overview.observedAt > 900_000);
  const ready = Boolean(overview && overview.availableExchanges >= 2 && finite(overview.longRatio) && finite(overview.shortRatio) && overview.longRatio >= 0 && overview.longRatio <= 1 && overview.shortRatio >= 0 && overview.shortRatio <= 1 && Math.abs(overview.longRatio + overview.shortRatio - 1) <= 0.001);
  return <section className={`perp-positioning-overview${stale ? " is-stale" : ""}`} aria-label={`${base} 跨所账户多空概览`}>
    <div className="perp-positioning-overview-heading"><h4>{base} 跨所账户多空概览<small>USDT 合约全体持仓账户比例 · 5 分钟</small></h4><span className={stale || !ready ? "perp-positioning-state is-warning" : "perp-positioning-state"}>{stale ? "资料过期 · 保留上次值" : ready ? "免费跨所汇总" : overview ? "资料不足" : "资料采集中"}</span></div>
    {ready ? <div className="perp-positioning-composition"><div className="perp-positioning-overview-values"><strong>多 <b>{share(overview!.longRatio)}</b></strong><strong>空 <b>{share(overview!.shortRatio)}</b></strong></div><div className="perp-positioning-bar" aria-hidden="true"><span style={{ width: `${overview!.longRatio! * 100}%` }}/><span style={{ width: `${overview!.shortRatio! * 100}%` }}/></div></div> : <p className="perp-positioning-insufficient">{overview ? "资料不足，至少需要 2 家有效官方数据" : "等待交易所官方账户比例"}</p>}
    <div className="perp-positioning-coverage"><strong>{stale ? "上次有效覆盖" : "有效覆盖"} {overview?.availableExchanges ?? "—"} / {overview?.totalExchanges ?? 5} 家</strong><span>{overview ? `当前发现 ${overview.eligibleExchanges} 家有对应 USDT 市场` : "对应 USDT 市场待核对"}</span><span>数据时间 {stamp(overview?.observedAt)} 北京时间</span></div>
    <p className="perp-positioning-method">每家交易所等权：对有效的多头账户比例取平均，空头比例为 100% 减去多头比例；缺失数据不补 50%。这是跨所比例概览，不是全网真实人数，不参与两腿质量评分。</p>
    <details className="perp-positioning-breakdown"><summary>查看五家交易所明细 <ChevronDown size={14} aria-hidden="true"/></summary><ul>{positioningVenues.map(venue => {
      const item = overview?.constituents.find(entry => entry.exchange === venue.id);
      const ratio = item?.key ? report?.positioning[item.key] : undefined;
      const error = item?.key ? report?.positioningErrors[item.key] : undefined;
      const status = item?.status ?? "pending";
      const sourceStale = stale || Boolean(ratio && now - ratio.observedAt > 900_000);
      const statusLabel = status === "fresh" && sourceStale ? "资料过期" : status === "fresh" && error ? "已纳入 · 更新失败" : positioningStatusLabels[status];
      const reason = item?.reason || error;
      return <li key={venue.id}><div className="perp-positioning-venue-heading"><strong>{venues.get(venue.id)?.name ?? venue.name}</strong><span className={status === "fresh" && !sourceStale && !error ? "perp-positioning-state" : "perp-positioning-state is-warning"}>{statusLabel}</span></div><small>{item?.symbol ?? (item ? "无对应 USDT 合约" : "对应合约待核对")}</small>{ratio ? <><p className="perp-positioning-venue-values">{status === "fresh" && !sourceStale ? "官方值" : "上次官方值"} · 多 {share(ratio.longRatio)} / 空 {share(ratio.shortRatio)}</p><small>{ratio.source.startsWith("https://") ? <a href={ratio.source} target="_blank" rel="noopener noreferrer">官方来源</a> : "官方来源"} · {stamp(ratio.observedAt)} 北京时间</small></> : null}{reason ? <p className="perp-positioning-reason">{reason}</p> : status === "pending" ? <p className="perp-positioning-reason">官方账户比例采集中</p> : sourceStale ? <p className="perp-positioning-reason">资料过期，保留上次值供核对</p> : null}</li>;
    })}</ul></details>
  </section>;
}

function QualityEvidence({ row, report, quality, venues, now, slippagePercent }: { row: PerpetualSpread; report: PerpetualQualityReport | null; quality: OpportunityQuality; venues: Map<string, PerpetualExchange>; now: number; slippagePercent: number }) {
  const asset = report?.assets[row.base];
  const history = pairQualityHistory(row, report);
  const spread = history?.spread, funding = history?.funding;
  const dilution = asset && finite(asset.marketCapUsd) && asset.marketCapUsd > 0 && finite(asset.fdvUsd) && asset.fdvUsd > 0 ? asset.marketCapUsd / asset.fdvUsd : null;
  const reportDelayed = Boolean(report && now - report.generatedAt > 180_000);
  const legs = [{ label: "做多腿", quote: row.long }, { label: "做空腿", quote: row.short }];
  return <div className="perp-quality-evidence">
    <div className="perp-quality-evidence-heading"><strong>聚合质量依据 <span>{quality.label}{quality.score === null ? "" : ` · ${quality.score} / 100`}</span></strong><span>{report ? `${reportDelayed ? "上次读取" : "最近读取"} ${stamp(report.generatedAt)} 北京时间` : "资料采集中"}</span></div>
    <div className="perp-quality-profiles">{Object.entries(quality.profiles).map(([key, profile]) => <section key={key} className={profile.status}><small>{key === "persistence" ? "价差持续性" : key === "convergence" ? "报价收窄证据" : "资金费收支方向"}</small><h4>{profile.label}</h4><p>{profile.detail}</p></section>)}</div>
    <section className="perp-convergence" aria-label="报价收窄历史"><h4>报价价差减半记录 <small>近 24h · 每 5 分钟真实采样</small></h4><p>以固定 UTC 时段的起点为基准，起始价差至少 0.05%；观察是否曾降至一半。各持有时长分别使用互不重叠的窗口；报价缺口整窗排除，尚未结束的窗口不计结果。</p>{history?.convergence ? <><div className="perp-convergence-scroll"><table><thead><tr><th>窗口</th><th>曾减半 / 完整窗口</th><th>减半占比</th><th>中位耗时</th><th>最大反向扩大</th><th>缺口 / 未结束</th></tr></thead><tbody>{history.convergence.horizons.map(item => <tr key={item.hours}><th>{item.hours}h</th><td>{item.successful} / {item.completed}</td><td>{share(item.successRatio)}</td><td>{item.medianMinutesToTarget === null ? "—" : `${item.medianMinutesToTarget} 分钟`}</td><td>{deviation(item.maxAdverseExpansionPercent)}</td><td>{item.incomplete} / {item.pending}</td></tr>)}</tbody></table></div><p>{history.convergence.samples} / 288 个样本 · 最近 {stamp(history.convergence.lastAt)}{history.convergence.lastAt && now - history.convergence.lastAt > 600_000 ? " · 已过期" : ""}。4h / 8h 窗口样本较少，仅展示记录。</p></> : <p>正在积累收窄历史；至少需要 12 小时采样与 6 个完整的 1h 窗口才参与评分。</p>}<p className="perp-quality-warning">这里衡量开仓报价的历史变化，未计退出买卖价、费用和成交容量，不是回测收益或盈利概率。</p></section>
    <PositioningOverviewCard base={row.base} report={report} venues={venues} now={now}/>
    <div className="perp-quality-grid">
      <section><h4>市值与 FDV <small>USD</small></h4><dl><div><dt>市值</dt><dd>{usd(asset?.marketCapUsd)}</dd></div><div><dt>完全稀释估值 / FDV</dt><dd>{usd(asset?.fdvUsd)}</dd></div><div><dt>市值 / FDV</dt><dd>{share(dilution)}</dd></div></dl><p>{asset ? <><a href={`https://www.coingecko.com/en/coins/${encodeURIComponent(asset.coinId)}`} target="_blank" rel="noopener noreferrer">{asset.name}</a> · CoinGecko · {stamp(asset.updatedAt)}</> : report?.assetErrors[row.base] || "市值资料采集中"}</p>{asset && (!asset.updatedAt || now - asset.updatedAt > 3_600_000) ? <p className="perp-quality-warning">市值资料已过期，未计入评分</p> : null}</section>
      <section><h4>交易所官方多空比例</h4>{legs.map(({ label, quote }) => {
        const key = `${quote.exchange}:${quote.symbol}`, ratio = report?.positioning[key], error = report?.positioningErrors[key];
        return <div className="perp-positioning-leg" key={key}><strong>{label} · {venues.get(quote.exchange)?.name ?? quote.exchange}</strong><small>{quote.symbol}</small>{ratio ? <><p className="perp-positioning-values">多 {share(ratio.longRatio)} <span>/</span> 空 {share(ratio.shortRatio)}</p><small>{ratio.kind === "accounts" ? "账户人数占比" : "持仓量占比"} · 范围：{ratio.scope}</small><small>{ratio.source.startsWith("https://") ? <a href={ratio.source} target="_blank" rel="noopener noreferrer">官方数据</a> : "官方数据"} · {stamp(ratio.observedAt)}{now - ratio.observedAt > 900_000 ? " · 已过期" : ""}</small>{error ? <p className="perp-quality-warning">保留上次值 · {error}</p> : null}</> : <p>{error || "官方多空资料采集中"}</p>}</div>;
      })}<p>账户人数与持仓量口径不混算。</p></section>
      <section><h4>盘口价差稳定度 <small>近 1h</small></h4><p className="perp-quality-samples">{spread?.samples ? `${spread.samples} / ${spread.expectedSamples} 个样本 · 覆盖 ${share(spread.coverage)}` : "采集中 · 暂无有效样本"}</p><dl><div><dt>价差均值</dt><dd>{percent(spread?.mean ?? null, 4)}</dd></div><div><dt>标准差</dt><dd>{deviation(spread?.stddev)}</dd></div><div><dt>正价差占比</dt><dd>{share(spread?.positiveRatio)}</dd></div></dl><p>{spread?.lastAt ? `最近有效样本 ${stamp(spread.lastAt)}${now - spread.lastAt > 180_000 ? " · 已过期" : ""}` : "等待同一平台组合的有效盘口"}{spread?.samples && spread.samples < 30 ? " · 尚未满 30 个有效点" : ""}</p></section>
      <section><h4>资金费稳定度 <small>近 24h · 折算 / 8h</small></h4><p className="perp-quality-samples">{funding?.samples ? `${funding.samples} / ${funding.expectedSamples} 个样本 · 覆盖 ${share(funding.coverage)}` : "采集中 · 暂无有效样本"}</p><dl><div><dt>做多腿标准差</dt><dd>{deviation(funding?.longStddev)}</dd></div><div><dt>做空腿标准差</dt><dd>{deviation(funding?.shortStddev)}</dd></div><div><dt>两腿费差均值</dt><dd>{percent(funding?.mean ?? null, 4)}</dd></div></dl><p>{funding?.lastAt ? `最近有效样本 ${stamp(funding.lastAt)}${now - funding.lastAt > 600_000 ? " · 已过期" : ""} · ` : ""}采样为实时预估费率，非已结算资金费。</p></section>
    </div>
    <div className="perp-quality-rubric">{quality.dimensions.map(dimension => <details key={dimension.id}><summary>{dimension.label}<span>{dimension.score === null ? "缺失 / 未评分" : `${dimension.score} / 100`} · 权重 {dimension.weight}%</span></summary><p>{dimension.detail}</p></details>)}</div>
    <section className="perp-taker-evidence" aria-label="双腿 taker 手续费"><h4>双腿 taker 手续费 <small>单次成交 · 按名义本金</small></h4><div>{legs.map(({ label, quote }, index) => {
      const fee = index === 0 ? quality.fees.long : quality.fees.short;
      return <div key={label}><strong>{label} · {venues.get(quote.exchange)?.name ?? quote.exchange}<b>{fee.percent === null ? "—" : `${fee.percent.toFixed(4)}%`}</b></strong><small>{quote.symbol} · {fee.basis === "account" ? "账户覆盖" : fee.basis === "public" ? "公开普通费率" : "费率待核实"}</small><p>{fee.detail}</p>{fee.source ? <small><a href={fee.source} target="_blank" rel="noopener noreferrer">官方来源</a>{fee.checkedAt ? ` · 核对 ${delistingFormat.format(fee.checkedAt)} 北京时间` : ""}</small> : null}</div>;
    })}</div><p>往返手续费 <strong>{quality.fees.roundTripPercent === null ? "—" : `${quality.fees.roundTripPercent.toFixed(4)}%`}</strong> · 双腿往返滑点 <strong>{slippagePercent.toFixed(2)}%</strong></p><p>每腿开、平仓各计一次 taker；以每腿相同名义本金估算，平仓成交额变化后实际费用也会变化。</p></section>
    <div className="perp-quality-conclusion"><p>扣 taker 手续费与滑点后价差 <strong>{percent(quality.netSpreadPercent)}</strong>；未计持有期资金费与实际成交差异。</p>{quality.reasons.length ? <ul>{quality.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}<p>分数是筛选参考，不代表盈利概率；数据覆盖按可评分维度权重计算，缺失项未补零。</p></div>
  </div>;
}

function QuoteDetails({ quotes, venues, mode, now, staleAfterMs, crossex, standalone = false }: { quotes: PerpetualQuote[]; venues: Map<string, PerpetualExchange>; mode: PerpetualPriceMode; now: number; staleAfterMs: number; crossex: PerpetualCrossExController; standalone?: boolean }) {
  return <div className={`perp-detail ${standalone ? "perp-all-quotes" : ""}`}>{!standalone ? <div className="perp-detail-heading"><strong>各平台报价</strong><span>按交易所展示，过期报价仅供核对</span></div> : null}
    <div className="perp-detail-scroll"><table><thead><tr><th>币种 / 交易所 / 合约</th><th>买一 / 卖一</th><th>标记价</th><th>资金费 / 原周期</th><th>折算 / 8h</th><th>下次结算</th><th>价格状态</th></tr></thead>
      <tbody>{quotes.map(quote => {
        const venue = venues.get(quote.exchange);
        const freshness = classifyPerpetualQuote(quote, mode, now, staleAfterMs);
        const fresh = venue?.status === "live" && freshness === "fresh";
        const priceTime = quotePriceTime(quote, mode);
        const normalized = normalizedFunding8h(quote, now);
        return <tr key={`${quote.exchange}:${quote.symbol}:${quote.quoteCurrency}`} className={fresh ? undefined : "perp-quote-stale"}>
          <th scope="row" className="perp-quote-identity"><strong>{quote.displayBase ?? quote.base}</strong><span>{venue?.name ?? quote.exchange}</span><small>{quote.symbol} · {quote.quoteCurrency}</small>{quote.comparable === false ? <small className="perp-unit-note">独立合约 · 不参与跨所排行</small> : null}{quote.contractUnit || quote.collateralCurrency ? <small>{quote.contractUnit ? `单位 ${quote.contractUnit}` : ""}{quote.collateralCurrency ? ` · 抵押 ${quote.collateralCurrency}` : ""}</small> : null}<DelistingNotice quote={quote} now={now}/><PerpetualPushToggle base={quote.base} settings={crossex}/></th>
          <td data-label="买一 / 卖一">{price(quote.bid)} / {price(quote.ask)}<small>{quote.quoteCurrency}</small></td>
          <td data-label="标记价">{price(quote.mark)}<small>{quote.quoteCurrency}</small></td>
          <td data-label="资金费 / 原周期">{normalized === null ? "—" : percent(quote.fundingRate! * 100, 4)}<small>{quote.fundingIntervalHours ? `每 ${quote.fundingIntervalHours}h` : "周期未知"}</small></td>
          <td data-label="折算 / 8h">{normalized === null ? "—" : percent(normalized * 100, 4)}</td>
          <td data-label="下次结算">{stamp(quote.nextFundingAt)}<small>北京时间</small></td>
          <td data-label="价格状态">{fresh ? "有效" : freshness === "stale" ? "已过期" : freshness === "unavailable" ? mode === "book" ? "暂无有效盘口" : "暂无标记价" : "平台未在线"}<small>{stamp(priceTime)} · {quote.transport.toUpperCase()}</small></td>
        </tr>;
      })}</tbody></table></div>
  </div>;
}

function PerpetualPanel({ active = true, interactionActive = active, onSummary, hubConnected = false }: SummaryProps & { active?: boolean; interactionActive?: boolean; hubConnected?: boolean }) {
  const [workspace, setWorkspace] = useState<"opportunities" | "positions" | "chart">("opportunities");
  const [chartSelection, setChartSelection] = useState<PerpetualChartSelection | null>(null);
  const [chartLinkError, setChartLinkError] = useState("");
  const opportunitiesActive = active && workspace === "opportunities";
  const marketActive = active && workspace !== "positions";
  const crossex = usePerpetualCrossExSettings(marketActive);
  const blockedKey = crossex.data ? JSON.stringify([crossex.data.revision, crossex.data.config]) : "";
  const [inspection, setInspection] = useState<{ key: string; base: string; snapshot: PerpetualSnapshot; ranking: PerpetualSpread[]; page: number; blockedKey: string } | null>(null);
  // Release frozen rows when the policy changes; metadata polling still applies below.
  if (inspection && inspection.blockedKey !== blockedKey) setInspection(null);
  const paused = opportunitiesActive && inspection !== null;
  const { data: liveData, connection, error, now, refresh } = usePerpetualFeed(marketActive, paused);
  const data = paused ? inspection.snapshot : liveData;
  const savedBlockedBases = crossex.data ? crossex.blockedBases : null;
  const visibleData = useMemo(() => visiblePerpetualSnapshot(data, savedBlockedBases), [data, savedBlockedBases]);
  const [filters, setFilters] = useState<PerpetualFilters>(defaultPerpetualFilters);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [scanner, setScanner] = useState<ScannerPreferences>(defaultScannerPreferences);
  const [scannerReady, setScannerReady] = useState(false);
  const [scannerSort, setScannerSort] = useState<ScannerSort | null>(null);
  const [sortReady, setSortReady] = useState(false);
  const activeSort = useMemo<ScannerSort>(() => scannerSort ?? { column: filters.sortBy === "funding" ? "fundingSpread" : "spread", direction: "desc" }, [scannerSort, filters.sortBy]);
  const sortRequirements = useMemo(() => scannerSortRequirements(scannerSort), [scannerSort]);
  const [rangeInputs, setRangeInputs] = useState<ScannerRangeInputs>(() => parseScannerRangeInputs({ spread: { min: "0" } }));
  const [rangesReady, setRangesReady] = useState(false);
  const ranges = useMemo(() => compileScannerRanges(rangeInputs), [rangeInputs]);
  const quoteRanges = useMemo(() => compileScannerRanges(parseScannerRangeInputs({ spread: rangeInputs.spread, fundingSpread: rangeInputs.fundingSpread, annualized: rangeInputs.annualized })), [rangeInputs.spread, rangeInputs.fundingSpread, rangeInputs.annualized]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const visibleColumns = useMemo(() => SCANNER_COLUMNS.filter(column => scanner.columns.includes(column.id)), [scanner.columns]);
  const categorySet = useMemo(() => new Set(scanner.categories), [scanner.categories]);
  const hasColumn = (id: ScannerColumnId) => scanner.columns.includes(id);
  const [qualityBudget, setQualityBudget] = useState(defaultQualityBudget);
  const [qualityBudgetReady, setQualityBudgetReady] = useState(false);
  const [hubPair, setHubPair] = useState<{ longExchange?: string; shortExchange?: string }>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertsVisited, setAlertsVisited] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>("execution");
  const [alertPair, setAlertPair] = useState<PerpetualSpread | null>(null);
  const expanded = paused ? inspection.key : null;
  const expandedBase = paused ? inspection.base : null;
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"rank" | "quotes">("rank");
  useEffect(() => {
    const restore = () => {
      const params = new URL(window.location.href).searchParams;
      const chart = readPerpetualChartSelection(params);
      if (params.get('perpView') === 'chart') {
        setChartSelection(chart); setChartLinkError(chart ? '' : '图表链接中的合约或时间范围无效，请从套利组合重新选择。');
        setInspection(null); setWorkspace('chart');
        return;
      }
      setWorkspace(params.get('perpView') === 'positions' ? 'positions' : 'opportunities');
      setChartLinkError('');
      if (params.get('perpView') === 'positions') return;
      const input = Object.fromEntries(['symbol', 'longExchange', 'shortExchange'].flatMap(key => params.has(key) ? [[key, params.get(key)!]] : []));
      const query = cleanHubQuery(input); if (!query) return;
      if (query.symbol) { setFilters(previous => ({ ...previous, search: query.symbol!, favoritesOnly: false, minSpreadPercent: 0 })); setRangeInputs(previous => ({ ...previous, spread: { min: "0", max: "" } })); setInspection(null); setWorkspace('opportunities'); setView('rank'); setPage(1); }
      setHubPair({ longExchange: query.longExchange, shortExchange: query.shortExchange });
    };
    // Preference hydration runs first; URL selection has priority.
    const timer = setTimeout(restore, 0); window.addEventListener('popstate', restore);
    return () => { clearTimeout(timer); window.removeEventListener('popstate', restore); };
  }, []);

  const search = useDeferredValue(filters.search);
  const quotes = visibleData?.quotes ?? emptyQuotes;
  const exchanges = data?.exchanges ?? emptyExchanges;
  const expired = Boolean(data && now - data.generatedAt > data.staleAfterMs);
  const venues = useMemo(() => new Map(exchanges.map(exchange => [exchange.id, exchange])), [exchanges]);
  const selected = useMemo(() => filters.exchanges === null ? null : new Set(filters.exchanges), [filters.exchanges]);
  const favorites = useMemo(() => new Set(filters.favorites), [filters.favorites]);
  const favoritePairs = useMemo(() => new Set(filters.favoritePairs ?? []), [filters.favoritePairs]);
  const { data: fx, error: fxError } = usePerpetualFx(opportunitiesActive && (filters.crossCurrency || (view === "rank" && ranges.valid && (ranges.needsFx || sortRequirements.needsFx))) && !paused);
  const netSort = filters.sortBy === "net";
  const fundingSort = filters.sortBy === "funding";
  const selectRanking = useMemo(() => createPerpetualRankingSelector(), []);
  const selectQuotes = useMemo(() => createPerpetualQuoteSelector(), []);
  const selectScannerPairs = useMemo(() => createScannerDataPairSelector(), []);
  const rankingFilters = useMemo(() => ({ ...filters, search, applyNumericThresholds: false }), [filters, search]);
  const fullRanking = useMemo(() => paused ? inspection.ranking : opportunitiesActive && view === "rank" && visibleData && now ? selectRanking(visibleData, rankingFilters, now, qualityBudget, fx) : emptySpreads, [paused, inspection, opportunitiesActive, view, visibleData, rankingFilters, now, selectRanking, qualityBudget, fx]);
  const qualifiedRanking = useMemo(() => filterCrossExRanking(fullRanking, crossex.error ? null : crossex.data, crossex.spotTransferPairs, now), [fullRanking, crossex.data, crossex.error, crossex.spotTransferPairs, now]);
  const categoryRanking = useMemo(() => qualifiedRanking.filter(row => categorySet.has(scannerPairCategory(row)) && (!hubPair.longExchange || row.long.exchange === hubPair.longExchange) && (!hubPair.shortExchange || row.short.exchange === hubPair.shortExchange)), [qualifiedRanking, hubPair, categorySet]);
  // Apply inexpensive quote conditions first; the data queue always sees all
  // remaining candidates, before metric/history filtering and pagination.
  const quoteRangeSelection = useMemo(() => {
    if (paused) return { matching: categoryRanking, missing: 0 };
    const matching: PerpetualSpread[] = [];
    let missing = 0;
    for (const row of categoryRanking) {
      const state = evaluateScannerRanges(row, quoteRanges, { now });
      if (state === "match") matching.push(row);
      else if (state === "missing") missing++;
    }
    return { matching, missing };
  }, [paused, categoryRanking, quoteRanges, now]);
  const candidateRanking = quoteRangeSelection.matching;
  const scannerRequirements = useMemo(() => ({ metrics: ranges.needsMetrics || sortRequirements.metrics, historyHours: [...new Set([...ranges.historyHours, ...sortRequirements.historyHours])].sort((a, b) => a - b) }), [ranges, sortRequirements]);
  const needsScannerData = scannerRequirements.metrics || scannerRequirements.historyHours.length > 0;
  const scannerPairs = useMemo(() => selectScannerPairs(ranges.valid && needsScannerData ? candidateRanking : emptySpreads), [selectScannerPairs, candidateRanking, ranges.valid, needsScannerData]);
  const { report: scannerData, loading: scannerLoading, error: scannerError } = usePerpetualScannerData(scannerPairs, scannerRequirements, opportunitiesActive && view === "rank" && rangesReady && sortReady && ranges.valid && needsScannerData && !paused);
  const rangeSelection = useMemo(() => {
    const matching: PerpetualSpread[] = [];
    let pending = 0, missing = quoteRangeSelection.missing;
    for (const row of candidateRanking) {
      const state = paused ? "match" : evaluateScannerRanges(row, ranges, { metrics: scannerData?.metrics, history: scannerData?.history, fx, now });
      if (state === "match") matching.push(row);
      else if (state === "pending") pending++;
      else if (state === "missing") missing++;
    }
    return { matching, pending, missing };
  }, [candidateRanking, quoteRangeSelection.missing, paused, ranges, scannerData, fx, now]);
  // Frozen rows keep their order while details are open; sorting always covers
  // the full matching set before the page is selected.
  const ranking = useMemo(() => paused || !scannerSort ? rangeSelection.matching : sortScannerRows(rangeSelection.matching, scannerSort, {
    metrics: scannerData?.metrics, history: scannerData?.history, fx, now, net: netSort,
    priceMode: filters.priceMode, staleAfterMs: data?.staleAfterMs ?? 30_000,
  }), [paused, scannerSort, rangeSelection.matching, scannerData, fx, now, netSort, filters.priceMode, data?.staleAfterMs]);
  if (paused && !ranking.some(row => perpetualSpreadKey(row) === inspection.key)) setInspection(null);
  const categoryQuotes = useMemo(() => quotes.filter(quote => categorySet.has(scannerQuoteCategory(quote))), [quotes, categorySet]);
  const quoteSelection = useMemo(() => selectQuotes(categoryQuotes, rankingFilters), [categoryQuotes, rankingFilters, selectQuotes]);
  const availableBases = quoteSelection.baseCount;
  const liveExchanges = exchanges.filter(exchange => exchange.status === "live").length;
  const quoteQuality = useMemo(() => {
    const counts = { stale: 0, unavailable: 0 };
    if (!opportunitiesActive || !now) return counts;
    for (const key of quoteSelection.keys) {
      const status = classifyPerpetualQuote(quoteSelection.byKey.get(key)!, filters.priceMode, now, data?.staleAfterMs ?? 30_000);
      if (status !== "fresh") counts[status]++;
    }
    return counts;
  }, [opportunitiesActive, quoteSelection, filters.priceMode, now, data?.staleAfterMs]);
  const totalItems = view === "rank" ? ranking.length : quoteSelection.keys.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const visiblePage = Math.max(1, Math.min(paused ? inspection.page : page, totalPages));
  const rows = useMemo(() => ranking.slice((visiblePage - 1) * pageSize, visiblePage * pageSize), [ranking, visiblePage]);
  const qualityPairs = useMemo(() => rows.map(row => ({ base: row.base, longKey: `${row.long.exchange}:${row.long.symbol}`, shortKey: `${row.short.exchange}:${row.short.symbol}`, ...(perpetualSpreadKey(row) === expanded ? { includeSeries: true } : {}) })), [rows, expanded]);
  const { report: qualityReport, loading: qualityLoading, error: qualityError } = usePerpetualQuality(qualityPairs, opportunitiesActive && view === "rank" && (scanner.columns.includes("quality") || paused || toolsOpen));
  const { report: fundingHistoryReport, error: fundingHistoryError } = usePerpetualFundingHistory(qualityPairs, opportunitiesActive && view === "rank" && (scanner.columns.some(column => column === "history24h" || column === "history7d" || column === "history30d") || paused));
  const { report: marketMetricsReport, error: marketMetricsError } = usePerpetualMarketMetrics(qualityPairs, opportunitiesActive && view === "rank" && (scanner.columns.includes("volume") || scanner.columns.includes("openInterest")));
  const qualities = useMemo(() => new Map(rows.map(row => [qualityPairKey(row), evaluateOpportunityQuality(row, qualityReport, now, qualityBudget, filters.priceMode)])), [rows, qualityReport, now, qualityBudget, filters.priceMode]);
  const fundingScenarios = useMemo(() => fundingSort ? new Map(rows.map(row => [perpetualSpreadKey(row), estimatePerpetualHoldingScenario(row, qualityBudget, { holdingHours: 24, exitSpreadPercent: row.spreadPercent, priceMode: filters.priceMode, staleAfterMs: data?.staleAfterMs }, now)])) : null, [fundingSort, rows, qualityBudget, filters.priceMode, data?.staleAfterMs, now]);
  const quoteRows = view === "quotes" ? quoteSelection.keys.slice((visiblePage - 1) * pageSize, visiblePage * pageSize).map(key => quoteSelection.byKey.get(key)!) : emptyQuotes;
  const detailQuotes = useMemo(() => expandedBase ? quotes.filter(quote => quote.base === expandedBase && (!selected || selected.has(quote.exchange))) : [], [quotes, expandedBase, selected]);
  useEffect(() => {
    const restore = (event?: StorageEvent) => {
      if (event && event.key !== scannerPreferencesKey) return;
      setInspection(null);
      try { setScanner(parseScannerPreferences(localStorage.getItem(scannerPreferencesKey))); } catch { /* Storage is optional. */ }
      setScannerReady(true);
    };
    restore(); window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, []);
  useEffect(() => {
    if (scannerReady) { try { localStorage.setItem(scannerPreferencesKey, JSON.stringify(scanner)); } catch { /* Storage is optional. */ } }
  }, [scanner, scannerReady]);
  useEffect(() => {
    const restore = (event?: StorageEvent) => {
      if (event && event.key !== scannerSortKey) return;
      setInspection(null); setPage(1);
      try { setScannerSort(parseScannerSort(localStorage.getItem(scannerSortKey))); } catch { /* Storage is optional. */ }
      setSortReady(true);
    };
    restore(); window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, []);
  useEffect(() => {
    if (sortReady) { try { localStorage.setItem(scannerSortKey, JSON.stringify(scannerSort)); } catch { /* Sorting remains available without storage. */ } }
  }, [scannerSort, sortReady]);
  useEffect(() => {
    function restoreRanges(event?: StorageEvent) {
      if (event && event.key !== scannerRangesKey) return;
      setInspection(null); setPage(1);
      try {
        const saved = localStorage.getItem(scannerRangesKey);
        if (saved !== null) setRangeInputs(parseScannerRangeInputs(saved));
        else {
          // Make the old active threshold visible once, then persist the new
          // independent ranges. Clearing a range really removes its bound.
          const legacy = parsePerpetualPreferences(localStorage.getItem(preferencesKey));
          setRangeInputs(parseScannerRangeInputs(legacy.sortBy === "funding"
            ? { fundingSpread: { min: String(legacy.minFundingSpreadPercent ?? 0) } }
            : { spread: { min: String(legacy.minSpreadPercent) } }));
        }
      } catch { /* Editing remains available without browser storage. */ }
      setRangesReady(true);
    }
    restoreRanges(); window.addEventListener("storage", restoreRanges);
    return () => window.removeEventListener("storage", restoreRanges);
  }, []);
  useEffect(() => {
    if (rangesReady) { try { localStorage.setItem(scannerRangesKey, JSON.stringify(rangeInputs)); } catch { /* Storage is optional. */ } }
  }, [rangeInputs, rangesReady]);

  useEffect(() => {
    function restorePreferences(event?: StorageEvent) {
      if (event && event.key !== preferencesKey) return;
      setInspection(null);
      try { setFilters(parsePerpetualPreferences(localStorage.getItem(preferencesKey))); } catch { /* Browser storage is optional. */ }
      setPreferencesReady(true);
    }
    restorePreferences();
    window.addEventListener("storage", restorePreferences);
    return () => window.removeEventListener("storage", restorePreferences);
  }, []);
  useEffect(() => {
    if (!preferencesReady) return;
    try { localStorage.setItem(preferencesKey, JSON.stringify({ version: 2, ...filters })); } catch { /* Filtering remains available with storage disabled. */ }
  }, [filters, preferencesReady]);
  useEffect(() => {
    function restoreBudget(event?: StorageEvent) {
      if (event && event.key !== qualityBudgetKey) return;
      try { setQualityBudget(parseQualityBudget(localStorage.getItem(qualityBudgetKey))); } catch { /* Budget editing remains available without storage. */ }
      setQualityBudgetReady(true);
    }
    restoreBudget();
    window.addEventListener("storage", restoreBudget);
    return () => window.removeEventListener("storage", restoreBudget);
  }, []);
  useEffect(() => {
    if (!qualityBudgetReady) return;
    try { localStorage.setItem(qualityBudgetKey, JSON.stringify({ version: 2, ...qualityBudget })); } catch { /* Budget editing remains available without storage. */ }
  }, [qualityBudget, qualityBudgetReady]);
  const summaryStatus = !data ? "loading" : data.status === "unavailable" ? "error" : expired || connection === "error" || data.status === "snapshot" ? "stale" : data.status === "connecting" ? "loading" : "live";
  const summaryTime = data ? Math.floor(data.generatedAt / 5_000) * 5_000 : null;
  useEffect(() => {
    if (!onSummary) return;
    onSummary({
      status: summaryStatus,
      fetchedAt: summaryTime === null ? null : new Date(summaryTime).toISOString(),
      metrics: [{ label: "覆盖币种", value: summaryTime === null ? "—" : String(availableBases) }, { label: expired ? "上次在线" : "实时平台", value: summaryTime === null ? "—" : `${liveExchanges} / ${exchanges.length}` }],
      note: paused ? "查看详情 · 行情刷新已暂停" : expired ? "快照已过期 · 连接数量为上次状态" : "CEX / DEX 永续合约 · 买卖盘口价差",
    });
  }, [summaryStatus, summaryTime, onSummary, availableBases, liveExchanges, exchanges.length, expired, paused]);

  function selectChart(selection: PerpetualChartSelection) {
    setInspection(null); setChartSelection(selection); setChartLinkError(""); setWorkspace("chart");
    const next = perpetualChartUrl(window.location.href, selection);
    if (next !== window.location.href) window.history.pushState(window.history.state, "", next);
    requestAnimationFrame(() => document.getElementById("perpetual-chart-heading")?.focus());
  }
  function openChart(row: PerpetualSpread) {
    selectChart({ base: row.base, longKey: `${row.long.exchange}:${row.long.symbol}`, shortKey: `${row.short.exchange}:${row.short.symbol}`, days: chartSelection?.days ?? 7 });
  }
  function leaveChart(next: "opportunities" | "positions" = "opportunities") {
    setInspection(null); setWorkspace(next);
    const url = perpetualWorkspaceUrl(window.location.href, next);
    if (url !== window.location.href) window.history.pushState(window.history.state, "", url);
  }
  function inspect(row: PerpetualSpread, toggle = false, tab: DetailTab = "execution") {
    const key = perpetualSpreadKey(row), base = row.base;
    if (toggle && expanded === key) { setInspection(null); return; }
    setDetailTab(tab);
    if (data) setInspection(previous => previous ? { ...previous, key, base } : { key, base, snapshot: data, ranking, page: visiblePage, blockedKey });
    requestAnimationFrame(() => { const table = document.querySelector(".scanner-table-wrap"); if (table) table.scrollLeft = 0; });
  }
  function updateFilters(update: Partial<PerpetualFilters>) {
    setInspection(null); setFilters(previous => ({ ...previous, ...update })); setPage(1);
    if (Object.hasOwn(update, "sortBy")) setScannerSort(null);
  }
  function changeScannerSort(column: ScannerSortColumn, leg?: "long" | "short") {
    setInspection(null); setPage(1); setScannerSort(nextScannerSort(activeSort, column, leg));
  }
  function updateRange(id: ScannerRangeId, bound: "min" | "max", value: string) {
    setInspection(null); setPage(1); setRangeInputs(previous => ({ ...previous, [id]: { ...previous[id], [bound]: value } }));
  }
  function clearRanges() { setInspection(null); setPage(1); setRangeInputs(parseScannerRangeInputs(null)); }
  function closeRanges() { setFiltersOpen(false); document.getElementById("perpetual-filter-toggle")?.focus(); }
  function changeView(next: "rank" | "quotes") { setInspection(null); setView(next); setPage(1); }
  function changeOpportunityMode(funding: boolean) { changeView("rank"); updateFilters({ sortBy: funding ? "funding" : fundingSort ? "gross" : filters.sortBy }); }
  function changePage(next: number) { setInspection(null); setPage(next); }
  function toggleExchange(id: string) {
    const next = new Set(filters.exchanges ?? exchanges.map(exchange => exchange.id));
    if (next.has(id)) next.delete(id); else next.add(id);
    updateFilters({ exchanges: next.size === exchanges.length ? null : [...next] });
  }
  function toggleFavorite(row: PerpetualSpread) {
    if (filters.favoritesOnly) setInspection(null);
    const key = perpetualSpreadKey(row);
    setFilters(previous => ({ ...previous, favoritePairs: (previous.favoritePairs ?? []).includes(key) ? previous.favoritePairs!.filter(item => item !== key) : [...(previous.favoritePairs ?? []), key].slice(-1000) }));
  }
  function resetFilters() { setHubPair({}); clearRanges(); setScanner(previous => ({ ...previous, categories: defaultScannerPreferences.categories })); updateFilters({ ...defaultPerpetualFilters, favorites: filters.favorites, favoritePairs: filters.favoritePairs, blockedPairs: filters.blockedPairs }); }
  function blockPair(row: PerpetualSpread) { updateFilters({ blockedPairs: [...new Set([...(filters.blockedPairs ?? []), perpetualSpreadKey(row)])].slice(-1000) }); }
  function openTool(tool: "health" | "alerts") {
    setToolsOpen(true);
    if (tool === "health") setHealthOpen(true);
    else { setAlertsVisited(true); setAlertsOpen(true); }
    requestAnimationFrame(() => document.getElementById(tool === "health" ? "perpetual-health-region" : "perpetual-alert-region")?.scrollIntoView({ behavior: "auto", block: "start" }));
  }
  function configureAlert(row: PerpetualSpread) {
    setToolsOpen(true); setAlertPair(row); setAlertsVisited(true); setAlertsOpen(true);
    requestAnimationFrame(() => document.getElementById("perpetual-alert-region")?.scrollIntoView({ behavior: "auto", block: "start" }));
  }

  function toggleCategory(id: ScannerCategoryId) {
    setInspection(null); setPage(1);
    setScanner(previous => ({ ...previous, categories: previous.categories.includes(id) ? previous.categories.filter(value => value !== id) : [...previous.categories, id] }));
  }
  function toggleRwa(checked: boolean) {
    setInspection(null); setPage(1);
    const rwa: ScannerCategoryId[] = ["equity", "commodity", "forex", "index"];
    setScanner(previous => ({ ...previous, categories: checked ? [...new Set([...previous.categories, ...rwa])] : previous.categories.filter(id => !rwa.includes(id)) }));
  }
  function toggleColumn(id: ScannerColumnId) {
    setScanner(previous => ({ ...previous, columns: previous.columns.includes(id) ? previous.columns.filter(value => value !== id) : [...previous.columns, id] }));
  }
  const statusText = paused ? "查看详情 · 行情刷新已暂停" : connection === "paused" ? "已暂停更新" : !data ? error ? "行情连接异常" : "正在连接行情" : data.status === "unavailable" ? "采集服务未就绪" : expired ? "快照已过期" : connection === "error" ? "更新中断" : data.status === "snapshot" ? "保留快照" : data.status === "connecting" ? "等待首批报价" : data.status === "partial" ? "部分平台在线" : "行情自动更新";
  const transportText = paused ? "收起后恢复" : connection === "stream" ? "自动刷新 / 20 秒" : connection === "polling" || connection === "error" ? "快照 / 20 秒" : connection === "paused" ? "切回后恢复" : "正在建立连接";
  const problem = error || data?.error || (data?.status === "unavailable" ? data.note || "请启动完整监控后台，连接交易所实时行情。" : "");
  const rangeEmptyMessage = !ranges.valid ? "请修正筛选框中标出的无效范围。" : ranges.active.length && categoryRanking.length > 0 && !ranking.length
    ? scannerError || (rangeSelection.pending > 0 ? `正在为全部候选组合补齐筛选数据，仍有 ${rangeSelection.pending} 个组合待采集，完成后自动显示匹配项。` : rangeSelection.missing > 0 ? "现有有效数据未找到匹配组合；部分组合缺少所需数据或汇率，也可能已经过期。" : "没有组合满足当前范围，可以调整条件或全部清除。") : "";
  const emptyMessage = !scanner.categories.length ? "请选择至少一种资产类别。" : qualifiedRanking.length > 0 && !ranking.length ? "当前类别或指定方向下没有可比较组合；未核验类别可在“类别”中启用“未分类”。" : !crossex.data ? crossex.error ? "屏蔽名单读取失败，暂不展示行情；恢复连接后自动重试。" : "正在读取已保存的屏蔽名单…" : !data ? "正在获取交易所与合约报价…" : data.status === "unavailable" ? "采集服务启动后，这里会显示实时合约价差。" : quotes.length === 0 ? data.quotes.length > 0 ? "当前币种均已屏蔽，可在上方“屏蔽币种”名单中解除屏蔽。" : "交易所正在连接，收到首批有效报价后自动更新。" : selected && selected.size < 2 ? "请至少选择两家交易所。" : filters.favoritesOnly && favorites.size + favoritePairs.size === 0 ? "点击组合旁的星标加入自选，再回来查看。" : crossex.error ? "资格设置读取失败，暂不展示排名；恢复连接后自动重试。" : crossex.data.config.requireSpotTransfer && fullRanking.length > 0 && qualifiedRanking.length === 0 ? "没有双边现货及共同网络双向充提均已核验的组合。未知、过期或不符合条件的组合已排除；可展开公开数据覆盖查看原因。" : fundingSort ? "当前筛选下没有可比较的资金费组合，可调整范围或交易所。" : netSort && filters.priceMode === "mark" ? "标记价仅供参考。切换买卖盘口可查看净价差排名。" : netSort ? "当前筛选下没有可比较的净价差组合，可调整范围或切换毛价差核对。" : "当前筛选下没有有效价差。可以调整范围、增加平台或切换报价口径。";

  return <section className={`perpetual-panel${workspace !== "positions" ? " perp-scanner" : ""}${fundingSort && view === "rank" ? " is-funding-mode" : ""}`} aria-label="CEX 与 DEX 合约价差监控">
    <header className="perp-heading"><div><h2>合约价差套利</h2></div><div className="perp-heading-actions" hidden={workspace !== "opportunities"}><button className="perp-refresh" type="button" aria-expanded={toolsOpen && healthOpen} aria-controls="perpetual-health-region" onClick={() => openTool("health")}><Activity size={15}/>报价健康</button><button className="perp-refresh" type="button" aria-expanded={toolsOpen && alertsOpen} aria-controls="perpetual-alert-region" onClick={() => openTool("alerts")}><Bell size={15}/>机会提醒</button><button className="perp-refresh" type="button" onClick={() => paused ? setInspection(null) : refresh()} disabled={!paused && connection === "paused"}><RefreshCw size={15}/>{paused ? "收起并恢复" : "刷新"}</button></div></header>
    <nav className="perp-workspace-nav" aria-label="合约价差工作区"><button type="button" aria-current={workspace === "opportunities" ? "page" : undefined} onClick={() => leaveChart()}>发现机会</button><button type="button" aria-current={workspace === "chart" ? "page" : undefined} onClick={() => { if (chartSelection) selectChart(chartSelection); else { setInspection(null); setWorkspace("chart"); } }}>创建价差图表</button><button id="perp-positions-tab" type="button" aria-current={workspace === "positions" ? "page" : undefined} onClick={() => leaveChart("positions")}>持仓跟踪</button></nav>
    {workspace === "positions" ? <Suspense fallback={<p role="status">正在加载持仓跟踪…</p>}><PerpetualPaper active={interactionActive} readActive={active}/></Suspense> : workspace === "chart" ? chartSelection ? <Suspense fallback={<p role="status">正在加载组合图表…</p>}><PerpetualChart key={JSON.stringify([chartSelection.base, chartSelection.longKey, chartSelection.shortKey])} selection={chartSelection} snapshot={visibleData} active={marketActive && Boolean(crossex.data) && !crossex.error} now={now} onSelectionChange={selectChart} onBack={() => leaveChart()} connectionError={crossex.error || problem}/></Suspense> : <div className="perp-empty"><h3 id="perpetual-chart-heading" tabIndex={-1}>创建价差图表</h3><p>{chartLinkError || "从套利列表点击组合，自动带入做多和做空合约，查看价差与 3、7、30 天资金费稳定度。"}</p><button type="button" onClick={() => leaveChart()}>选择套利组合</button></div> : <>
    <div className="scanner-toolbar">
      <div className="perp-view-tabs" role="group" aria-label="行情视图">
        <button type="button" aria-pressed={view === "rank" && !fundingSort} onClick={() => changeOpportunityMode(false)}>价格套利</button>
        <button type="button" aria-pressed={view === "rank" && fundingSort} onClick={() => changeOpportunityMode(true)}>资金费套利</button>
        <button type="button" aria-pressed={view === "quotes"} onClick={() => changeView("quotes")}>全部报价</button>
      </div>
      <ScannerMenu label={`交易所（${exchanges.filter(exchange => !selected || selected.has(exchange.id)).length} / ${exchanges.length}）`} className="scanner-exchange-menu">
        <div className="scanner-menu-actions"><button type="button" onClick={() => updateFilters({ exchanges: null })}>全选</button><button type="button" onClick={() => updateFilters({ exchanges: [] })}>清空</button></div>
        {exchanges.map(exchange => <label key={exchange.id}><input type="checkbox" checked={!selected || selected.has(exchange.id)} onChange={() => toggleExchange(exchange.id)}/><span>{exchange.name}</span><small className={exchange.status === "live" && !expired ? "positive" : ""}>{expired ? "快照过期" : exchangeLabels[exchange.status]}</small></label>)}
        {!exchanges.length ? <p>正在读取交易所…</p> : null}
      </ScannerMenu>
      <label className="perp-search"><Search size={14} aria-hidden="true"/><input aria-label="搜索币种" placeholder="筛选币种…" value={filters.search} maxLength={40} onChange={event => updateFilters({ search: event.target.value.toUpperCase() })}/>{filters.search ? <button type="button" aria-label="清空搜索" onClick={() => updateFilters({ search: "" })}><X size={13}/></button> : null}</label>
      <button id="perpetual-filter-toggle" type="button" className={`perp-tool-button ${filtersOpen || ranges.active.length ? "is-selected" : ""}`} aria-expanded={filtersOpen} aria-controls="perpetual-filters" onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal size={14}/>筛选{ranges.active.length ? <span>{ranges.active.length}</span> : null}<ChevronDown size={12}/></button>
      {view === "rank" ? <ScannerMenu label={`显示列（${visibleColumns.length} / ${SCANNER_COLUMNS.length}）`}>
        <div className="scanner-menu-actions"><button type="button" onClick={() => setScanner(previous => ({ ...previous, columns: defaultScannerPreferences.columns }))}>恢复默认列</button></div>
        {SCANNER_COLUMNS.map(column => <label key={column.id}><input type="checkbox" checked={hasColumn(column.id)} onChange={() => toggleColumn(column.id)}/>{column.label}</label>)}
      </ScannerMenu> : null}
      <label className="scanner-asset-toggle"><input type="checkbox" checked={["equity", "commodity", "forex", "index"].every(id => scanner.categories.includes(id as ScannerCategoryId))} onChange={event => toggleRwa(event.target.checked)}/>RWA</label>
      <label className="scanner-asset-toggle"><input type="checkbox" checked={categorySet.has("crypto")} onChange={() => toggleCategory("crypto")}/>加密</label>
      <ScannerMenu label={`类别（${scanner.categories.length} / ${SCANNER_CATEGORIES.length}）`}>
        <div className="scanner-menu-actions"><button type="button" onClick={() => { setInspection(null); setPage(1); setScanner(previous => ({ ...previous, categories: defaultScannerPreferences.categories })); }}>全部类别</button></div>
        {SCANNER_CATEGORIES.map(category => <label key={category.id}><input type="checkbox" checked={categorySet.has(category.id)} onChange={() => toggleCategory(category.id)}/>{category.label}</label>)}
        <p>按交易所已核验分类；未知或两腿分类不一致归入未分类。</p>
      </ScannerMenu>
      <button type="button" className={`perp-tool-button ${filters.favoritesOnly ? "is-selected" : ""}`} aria-pressed={filters.favoritesOnly} onClick={() => updateFilters({ favoritesOnly: !filters.favoritesOnly })}><Star size={14}/>自选<span>{favoritePairs.size}{favorites.size ? ` + ${favorites.size} 币` : ""}</span></button>
    </div>
    {filtersOpen ? <ScannerRangeFilters inputs={rangeInputs} compiled={ranges} onChange={updateRange} onClear={clearRanges} onClose={closeRanges}/> : null}
    <div className="scanner-status"><div className={`perp-connection ${expired || error || data?.status === "unavailable" ? "is-warning" : ""}`} role="status"><i aria-hidden="true"/>{statusText}<span>{transportText}</span></div><span>{totalItems} {view === "rank" ? "组合" : "报价"} · {liveExchanges} / {exchanges.length} 平台在线 · 更新 {stamp(data?.generatedAt)} 北京时间</span><span className="scanner-direction-key"><i className="positive">多</i> 做多腿在上 <i className="negative">空</i> 做空腿在下</span></div>
    {view === "rank" && ranges.active.length > 0 ? <div className="scanner-filter-progress" role="status" aria-label="全量筛选状态">
      {!ranges.valid ? <span className="scanner-filter-pending">请修正无效范围</span> : <><span>筛选范围：全部 {categoryRanking.length} 个候选组合</span><span>匹配 {ranking.length}</span>{rangeSelection.pending > 0 ? <span className="scanner-filter-pending">{!ranges.needsMetrics && ranges.historyHours.length === 1 && ranges.historyHours[0] === 720 ? "30天历史待补齐" : "待采集"} {rangeSelection.pending}{scannerLoading ? " · 自动补齐中" : ""}</span> : null}{rangeSelection.missing > 0 ? <span>缺失或过期 {rangeSelection.missing}</span> : null}{(scannerData?.progress?.deferred ?? 0) > 0 ? <span>部分数据稍后重试</span> : null}</>}
    </div> : null}
    {problem ? <div className="perp-notice" role="status">{problem}</div> : null}
    {view === "rank" && scannerSort ? <div className="scanner-filter-progress" role="status" aria-label="全量排序状态"><span>排序：{SCANNER_COLUMNS.find(column => column.id === scannerSort.column)?.label}{scannerSort.leg ? ` · ${scannerSort.leg === "long" ? "多腿" : "空腿"}` : ""} · {scannerSort.direction === "desc" ? "从高到低" : "从低到高"}</span><span>{sortRequirements.needsFx ? "按 USDT 等值比较，显示保留原币；" : ""}缺失或过期置后</span>{needsScannerData && (scannerData?.progress?.pending ?? 0) > 0 ? <span className="scanner-filter-pending">排序数据待采集 {scannerData?.progress?.pending}{scannerLoading ? " · 自动补齐中" : ""}</span> : null}</div> : null}
    {data?.storageError ? <div className="perp-notice" role="status">快照保存异常：{data.storageError}</div> : null}
    {crossex.error || crossex.saveError ? <div className="perp-notice" role="alert">{crossex.saveError || crossex.error}</div> : null}
    {crossex.data?.config.requireSpotTransfer ? <p className="scanner-data-note">现货充提筛选已开启：仅显示已核验的合格组合。</p> : null}
    {view === "rank" && scannerError ? <p className="perp-quality-notice" role="status">{scannerError}</p> : null}
    {view === "rank" && ranges.needsFx && fxError && !filters.crossCurrency ? <p className="perp-quality-notice" role="status">金额筛选所需汇率暂不可用，缺失汇率的组合暂不匹配。</p> : null}
    {view === "rank" && sortRequirements.needsFx && fxError && !filters.crossCurrency ? <p className="perp-quality-notice" role="status">排序所需汇率暂不可用，缺失汇率的组合排在末尾。</p> : null}
    {view === "rank" && fundingHistoryError ? <p className="perp-quality-notice" role="status">{fundingHistoryError}</p> : null}
    {view === "rank" && marketMetricsError ? <p className="perp-quality-notice" role="status">{marketMetricsError}</p> : null}
    {filters.crossCurrency ? <p className="perp-currency-warning">{fxError || (fx ? `汇率快照 ${stamp(fx.generatedAt)} · 仅纳入有新鲜买卖汇率的组合；USD 等缺失汇率不假定等于 1。换汇手续费另计。` : "正在读取现货汇率，缺失汇率的跨币组合暂不参与排名。")}</p> : null}
    {filters.crossCurrency && fx ? <details className="perp-fx-details"><summary>查看每条汇率的来源时间与买卖价</summary><div>{["USDC", "USD1", "USDG", "USD"].map(currency => { const rate = fx.rates[currency]; return <p key={currency}><strong>{currency} / USDT</strong> · {rate ? <>买 {rate.bid.toFixed(6)} / 卖 {rate.ask.toFixed(6)} · 源时间 {stamp(rate.at)}{now - rate.at > fx.staleAfterMs ? " · 已过期" : ""}</> : "未纳入"}{fx.reasons?.[currency] ? <span> · {fx.reasons[currency]}</span> : null}</p>; })}</div></details> : null}
    {view === "quotes" ? <><p className="perp-quotes-caption">平台组合与价差阈值仅影响排名。此处保留原始合约单位，独立合约不参与跨所比较。</p><div className="perp-table-wrap"><QuoteDetails crossex={crossex} quotes={quoteRows} venues={venues} mode={filters.priceMode} now={now} staleAfterMs={data?.staleAfterMs ?? 30_000} standalone/>{!quoteRows.length ? <div className="perp-empty"><strong>暂无符合条件的报价</strong><p>{!data || !quotes.length ? emptyMessage : "可以调整币种搜索或交易所筛选。"}</p></div> : null}</div></> : <div className="perp-table-wrap scanner-table-wrap" tabIndex={0} role="region" aria-label="套利组合表格，可横向滚动"><table className="perp-table perp-scanner-table"><thead><tr><th scope="col">币种</th>{visibleColumns.map(column => {
      const sortable = sortableScannerColumns.has(column.id) ? column.id as ScannerSortColumn : null;
      const sorted = activeSort.column === column.id;
      const dualLeg = column.id === "volume" || column.id === "openInterest" || column.id === "quote";
      const label = column.id === "spread" ? netSort ? "净价差" : filters.priceMode === "mark" ? "标记价差" : column.label : column.label;
      const nextDirection = (leg?: "long" | "short") => sorted && activeSort.direction === "desc" && (!dualLeg || activeSort.leg === (leg ?? "long")) ? "升序" : "降序";
      const arrow = sorted ? activeSort.direction === "desc" ? "↓" : "↑" : "↕";
      return <th scope="col" key={column.id} data-column={column.id} aria-sort={sortable && sorted ? activeSort.direction === "desc" ? "descending" : "ascending" : undefined}>
        {sortable ? <button type="button" className="scanner-sort-column" aria-label={`${label}，${dualLeg ? "多腿，" : ""}点击按${nextDirection()}排序`} onClick={() => changeScannerSort(sortable, dualLeg ? "long" : undefined)}>{label}<span aria-hidden="true">{arrow}</span></button> : label}
        {dualLeg && sortable ? <div className="scanner-sort-legs">{(["long", "short"] as const).map(leg => <button type="button" key={leg} data-sort-leg={leg} aria-pressed={sorted && activeSort.leg === leg} aria-label={`${label}，${leg === "long" ? "多腿" : "空腿"}，点击按${nextDirection(leg)}排序`} onClick={() => changeScannerSort(sortable, leg)}>{leg === "long" ? "多" : "空"}{sorted && activeSort.leg === leg ? <span aria-hidden="true">{arrow}</span> : null}</button>)}</div> : null}
        {column.id === "fundingSpread" ? <small>/ 8h</small> : column.id === "annualized" ? <small>当前费率估算</small> : column.id === "quote" ? <small>{filters.priceMode === "book" ? "多卖一 / 空买一" : "标记价 · 仅供参考"}</small> : null}
      </th>;
    })}<th scope="col"><span className="perp-sr-only">展开组合详情</span></th></tr></thead>
      <tbody>{rows.map(row => {
        const rowKey = perpetualSpreadKey(row), isExpanded = expanded === rowKey;
        const detailId = `perp-detail-${encodeURIComponent(rowKey)}`;
        const pairLabel = `${row.base}，做多 ${venues.get(row.long.exchange)?.name ?? row.long.exchange} ${row.long.symbol}，做空 ${venues.get(row.short.exchange)?.name ?? row.short.exchange} ${row.short.symbol}`;
        const quality = qualities.get(rowKey)!;
        const primarySpread = netSort ? row.netSpreadPercent ?? null : row.spreadPercent;
        const isFavorite = favoritePairs.has(rowKey);
        const history = pairQualityHistory(row, qualityReport);
        const historicalDeviation = history && !row.crossCurrency && filters.priceMode === "book" && history.spread.samples >= 30 && history.spread.coverage >= .5 && history.spread.lastAt && now - history.spread.lastAt <= 180_000 && finite(history.spread.mean) ? (row.spreadPercent - history.spread.mean) * 100 : null;
        const longFunding = normalizedFunding8h(row.long, now), shortFunding = normalizedFunding8h(row.short, now);
        const fundingSpread = longFunding === null || shortFunding === null ? null : shortFunding - longFunding;
        const fundingScenario = fundingScenarios?.get(rowKey);
        const category = scannerPairCategory(row);
        const categoryLabel = SCANNER_CATEGORIES.find(item => item.id === category)?.label ?? "未分类";
        const annualized = annualizedFundingPercent(fundingSpread);
        const historyPair = { base: row.base, longKey: `${row.long.exchange}:${row.long.symbol}`, shortKey: `${row.short.exchange}:${row.short.symbol}` };
        const longMetric = scannerRequirements.metrics ? scannerData?.metrics[historyPair.longKey] : marketMetricsReport?.legs[historyPair.longKey];
        const shortMetric = scannerRequirements.metrics ? scannerData?.metrics[historyPair.shortKey] : marketMetricsReport?.legs[historyPair.shortKey];
        const cells: Record<ScannerColumnId, ReactNode> = {
          type: <span className="scanner-type-tag" title={categoryLabel} aria-label={categoryLabel}>{category === "crypto" ? "C" : category === "unknown" ? "?" : "R"}</span>,
          pair: <button type="button" className="scanner-pair scanner-chart-link" aria-label={`创建价差图表：${pairLabel}`} onClick={() => openChart(row)}><ScannerLeg quote={row.long} name={venues.get(row.long.exchange)?.name ?? row.long.exchange} side="long" now={now}/><ScannerLeg quote={row.short} name={venues.get(row.short.exchange)?.name ?? row.short.exchange} side="short" now={now}/></button>,
          funding: <><ScannerFundingRate quote={row.long} now={now}/><ScannerFundingRate quote={row.short} now={now}/></>,
          fundingSpread: <span className={scannerPolarity(fundingSpread)}>{scannerPercent(fundingSpread === null ? null : fundingSpread * 100)}</span>,
          annualized: <span className={scannerPolarity(annualized)} title="当前 8h 资金费差 × 3 × 365；按单腿等名义本金简单外推，未扣费用，不复利">{scannerPercent(annualized, 1)}</span>,
          volume: <ScannerMarketMetric long={longMetric} short={shortMetric} metricName="volume24h" now={now}/>,
          openInterest: <ScannerMarketMetric long={longMetric} short={shortMetric} metricName="openInterest" now={now}/>,
          quote: <div className="scanner-stack"><div title={String(row.buyPrice)}>{price(row.buyPrice)} <small>{row.long.quoteCurrency}</small></div><div title={String(row.sellPrice)}>{price(row.sellPrice)} <small>{row.short.quoteCurrency}</small></div>{now - row.updatedAt > (data?.staleAfterMs ?? 30_000) ? <small className="scanner-stale">报价已过期</small> : null}</div>,
          spread: <div className={scannerPolarity(primarySpread)} title={historicalDeviation === null ? undefined : `较 1h 均值 ${historicalDeviation.toFixed(1)} bp`}><strong>{percent(primarySpread)}</strong><small className="secondary">{netSort ? "毛" : "净"} {percent(netSort ? row.spreadPercent : row.netSpreadPercent ?? null)}</small></div>,
          history24h: <ScannerHistory long={fundingHistoryReport?.legs[historyPair.longKey]} short={fundingHistoryReport?.legs[historyPair.shortKey]} total={scannerRequirements.historyHours.includes(24) ? scannerDataHistoryForPair(scannerData, historyPair, 24) ?? null : undefined} now={now}/>,
          history7d: <ScannerHistory long={fundingHistoryReport?.legs[historyPair.longKey]} short={fundingHistoryReport?.legs[historyPair.shortKey]} total={scannerRequirements.historyHours.includes(168) ? scannerDataHistoryForPair(scannerData, historyPair, 168) ?? null : undefined} now={now} hours={168}/>,
          history30d: <ScannerHistory long={fundingHistoryReport?.legs[historyPair.longKey]} short={fundingHistoryReport?.legs[historyPair.shortKey]} total={scannerRequirements.historyHours.includes(720) ? scannerDataHistoryForPair(scannerData, historyPair, 720) ?? null : undefined} now={now} hours={720}/>,
          time: <div className="scanner-time"><time dateTime={new Date(row.updatedAt).toISOString()}>{stamp(row.updatedAt)}</time><small>{age(row.updatedAt, now)}{paused ? now - row.updatedAt > (data?.staleAfterMs ?? 30_000) ? " · 已过期" : " · 已暂停" : ""}</small></div>,
          quality: <QualityCell quality={quality} pairLabel={pairLabel} onInspect={() => inspect(row, false, "quality")}/>,
        };
        return <Fragment key={rowKey}><tr className={`${isExpanded ? "perp-row-expanded " : ""}scanner-chart-row`} onClick={event => { const target = event.target as HTMLElement; if (event.currentTarget.contains(target) && !target.closest('button, a, input, select, summary')) openChart(row); }}>
          <th scope="row" className="perp-base-cell"><button type="button" className={`perp-star ${isFavorite ? "is-favorite" : ""}`} aria-label={`${isFavorite ? "移除" : "收藏"}组合：${pairLabel}`} aria-pressed={isFavorite} onClick={() => toggleFavorite(row)}><Star size={15} fill={isFavorite ? "currentColor" : "none"}/></button><div><strong>{row.base}</strong><small>{row.crossCurrency ? `${row.long.quoteCurrency} / ${row.short.quoteCurrency}` : row.long.quoteCurrency}{row.fxAdjusted ? " · 已换汇" : ""}</small><PerpetualPushToggle base={row.base} settings={crossex}/></div></th>
          {visibleColumns.map(column => <td key={column.id} data-column={column.id} className="scanner-number">{cells[column.id]}</td>)}
          <td className="perp-expand-cell"><button type="button" aria-label={`${isExpanded ? "收起" : "展开"} ${pairLabel} 质量依据与各平台报价`} aria-expanded={isExpanded} aria-controls={detailId} onClick={() => inspect(row, true)}><ChevronDown size={16}/></button></td>
        </tr>{isExpanded ? <tr className="perp-detail-row" id={detailId}><td colSpan={visibleColumns.length + 2}>
          <div className="perp-inspection-bar"><p role="status"><strong>行情已暂停</strong> · 保留 {stamp(data?.generatedAt)} 的排名与报价{now - row.updatedAt > (data?.staleAfterMs ?? 30_000) ? " · 报价已过期，仅供核对" : ""}</p><button type="button" onClick={() => setInspection(null)}>收起并恢复</button></div>
          <div className="scanner-detail-evidence"><button type="button" className="perp-refresh" onClick={() => openChart(row)}>创建价差图表 · 资金费稳定度</button><SpotTransferEvidence row={row} settings={crossex} now={now}/><DelistingNotice quote={row.long} now={now}/><DelistingNotice quote={row.short} now={now}/><FundingHistory long={fundingHistoryReport?.legs[`${row.long.exchange}:${row.long.symbol}`]} short={fundingHistoryReport?.legs[`${row.short.exchange}:${row.short.symbol}`]} now={now}/>{fundingScenario ? <p>未来 24h 资金费 {percent(fundingScenario.fundingPercent, 4)} · 未来 24h 扣费后 {percent(fundingScenario.estimatedNetPercent, 4)}{fundingScenario.reasons.length ? ` · ${fundingScenario.reasons[0]}` : ""}</p> : null}</div>
          <div className="perp-detail-navigation"><div role="tablist" aria-label="组合详情" onKeyDown={event => { const tabs: DetailTab[] = ["execution", "quality", "exit", "quotes"]; const index = tabs.indexOf(detailTab); const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null; if (next) { event.preventDefault(); setDetailTab(next); document.getElementById(`${detailId}-tab-${next}`)?.focus(); } }}>{([{ id: "execution", label: "成交与持有" }, { id: "quality", label: "质量依据" }, { id: "exit", label: "平仓与跟踪" }, { id: "quotes", label: "各平台报价" }] as const).map(tab => <button type="button" role="tab" key={tab.id} id={`${detailId}-tab-${tab.id}`} aria-selected={detailTab === tab.id} tabIndex={detailTab === tab.id ? 0 : -1} aria-controls={`${detailId}-content`} onClick={() => setDetailTab(tab.id)}>{tab.label}</button>)}</div><div className="perp-detail-actions">{hubConnected && [row.long.exchange, row.short.exchange].every(id => ["binance", "bybit", "okx", "gate", "kraken", "hyperliquid", "lighter"].includes(id)) && <button type="button" onClick={() => hubNavigate("crossex", { symbol: row.base, longExchange: row.long.exchange, shortExchange: row.short.exchange })}>在 CrossEx 查看</button>}<button type="button" onClick={() => configureAlert(row)}><Bell size={13}/>{fundingSort ? "设置价差提醒" : "设置提醒"}</button><button type="button" onClick={() => blockPair(row)}><X size={13}/>屏蔽组合</button></div></div>
          <div role="tabpanel" id={`${detailId}-content`} aria-labelledby={`${detailId}-tab-${detailTab}`} className="perp-detail-content"><Suspense fallback={<p role="status">正在加载组合详情…</p>}>
            {detailTab === "execution" ? <><PerpetualExecution long={row.long} short={row.short} active={interactionActive} now={now}/><PerpetualHolding row={row} budget={qualityBudget} now={now} mode={filters.priceMode} fundingFocused={fundingSort}/><PerpetualTrend history={history} now={now} crossCurrency={row.crossCurrency}/></> : detailTab === "quality" ? <QualityEvidence row={row} report={qualityReport} quality={quality} venues={venues} now={now} slippagePercent={qualityBudget.slippagePercent}/> : detailTab === "exit" ? <PerpetualExit long={row.long} short={row.short} budget={qualityBudget} active={interactionActive && opportunitiesActive} now={now} onRegistered={() => { setInspection(null); setWorkspace("positions"); document.getElementById("perp-positions-tab")?.focus(); }}/> : <QuoteDetails crossex={crossex} quotes={detailQuotes} venues={venues} mode={filters.priceMode} now={now} staleAfterMs={data?.staleAfterMs ?? 30_000}/>}
          </Suspense></div>
        </td></tr> : null}</Fragment>;
      })}</tbody></table>
      {!rows.length ? <div className="perp-empty"><span aria-hidden="true">—</span><strong>{!data || data.status === "connecting" ? "等待实时报价" : fundingSort ? "暂无符合条件的资金费机会" : "暂无符合条件的价差"}</strong><p>{rangeEmptyMessage || emptyMessage}</p>{quotes.length > 0 ? <button type="button" onClick={resetFilters}>重置筛选</button> : null}</div> : null}
    </div>}
    <div className="perp-pagination"><span>{totalItems ? `${(visiblePage - 1) * pageSize + 1}–${Math.min(visiblePage * pageSize, totalItems)} / ${totalItems} ${view === "rank" ? "组合" : "报价"}` : `0 ${view === "rank" ? "组合" : "报价"}`}<small>每页 {pageSize} 条</small></span><div><button type="button" aria-label="上一页" disabled={visiblePage <= 1} onClick={() => changePage(visiblePage - 1)}><ChevronLeft size={16}/></button><span>{visiblePage} / {totalPages}</span><button type="button" aria-label="下一页" disabled={visiblePage >= totalPages} onClick={() => changePage(visiblePage + 1)}><ChevronRight size={16}/></button></div></div>
    {view === "rank" ? <p className="scanner-data-note">点击数值列表头切换升降序，成交额、持仓量和报价可分别按多腿 / 空腿排序；排序覆盖全部筛选结果。资金费差统一折算 / 8h；年化按当前费率简单外推。24h、7 天和 30 天实际为已结算资金费净累计，非账户盈亏。成交额与持仓金额保留来源计价币，点击数值查看来源时间；指标以 30 秒为更新目标，历史每 5 分钟更新，首次回补期间显示采集状态。展开组合可查看双腿累计与成本估算。</p> : null}
    <details className="scanner-tools" open={toolsOpen} onToggle={event => setToolsOpen(event.currentTarget.open)}><summary>监控工具与设置<ChevronDown size={14}/></summary><div className="scanner-tools-content">
      <details className="scanner-advanced-filters"><summary>更多筛选与排序设置</summary>
        <div className="perp-filter-fields">
          <label>价差排序<select aria-label="价差排序" value={filters.sortBy ?? "gross"} onChange={event => updateFilters({ sortBy: event.target.value as PerpetualFilters["sortBy"] })}><option value="gross">毛价差从高到低</option><option value="net">净价差从高到低</option><option value="funding">资金费差从高到低 / 8h</option></select></label>
          <label>报价口径<select value={filters.priceMode} onChange={event => updateFilters({ priceMode: event.target.value as PerpetualPriceMode })}><option value="book">买卖盘口</option><option value="mark">标记价格 · 仅供参考</option></select></label>
          <label>平台组合<select value={filters.pairMode} onChange={event => updateFilters({ pairMode: event.target.value as PerpetualPairMode })}><option value="all">全部组合</option><option value="cex-dex">CEX ↔ DEX</option><option value="cex-cex">CEX ↔ CEX</option><option value="dex-dex">DEX ↔ DEX</option></select></label>
          <label>计价币范围<select value={filters.crossCurrency ? "cross" : "same"} onChange={event => updateFilters({ crossCurrency: event.target.value === "cross" })}><option value="same">仅相同计价币</option><option value="cross">跨计价币 · 按现货汇率校正</option></select></label>
        </div>
        {favorites.size ? <div className="perp-saved-legacy"><span>旧版币种自选（包含全部组合）</span>{filters.favorites.map(base => <button type="button" key={base} onClick={() => updateFilters({ favorites: filters.favorites.filter(item => item !== base) })}>{base}<X size={12}/><span className="perp-sr-only">移除币种自选</span></button>)}</div> : null}
        {favoritePairs.size ? <details className="perp-blocked"><summary>管理 {favoritePairs.size} 个自选组合</summary><ul>{filters.favoritePairs!.map(key => <li key={key}><span>{pairName(key)}</span><button type="button" onClick={() => updateFilters({ favoritePairs: filters.favoritePairs!.filter(item => item !== key) })}>取消收藏</button></li>)}</ul></details> : null}
        {(filters.blockedPairs?.length ?? 0) > 0 ? <details className="perp-blocked"><summary>已屏蔽 {filters.blockedPairs!.length} 个组合</summary><ul>{filters.blockedPairs!.map(key => <li key={key}><span>{pairName(key)}</span><button type="button" onClick={() => updateFilters({ blockedPairs: filters.blockedPairs!.filter(item => item !== key) })}>恢复</button></li>)}</ul></details> : null}
        <div className="perp-filter-footer"><span>范围、筛选与组合自选保存在当前浏览器</span><button type="button" onClick={resetFilters}>重置全部筛选</button></div>
      </details>
      <button type="button" className="perp-tool-button" title="选择七所并按现货买卖汇率比较；模拟资格由 CrossEx 模块再次核对" onClick={() => { changeView("rank"); updateFilters({ exchanges: ["binance", "bybit", "okx", "gate", "kraken", "hyperliquid", "lighter"], crossCurrency: true, pairMode: "all", priceMode: "book", search: "", favoritesOnly: false, sortBy: "gross", minSpreadPercent: 0 }); }}>CrossEx 七所</button>
      <Suspense fallback={null}><PerpetualManualPairs snapshot={data} mode={filters.priceMode} now={now} budget={qualityBudget} active={opportunitiesActive && toolsOpen} paused={paused}/></Suspense>
      <div id="perpetual-health-region" hidden={!healthOpen}><Suspense fallback={<p role="status">正在加载报价健康…</p>}>{healthOpen ? <PerpetualHealth active={active} defaultOpen/> : null}</Suspense></div>
      <div id="perpetual-alert-region" hidden={!alertsOpen}><Suspense fallback={<p role="status">正在加载机会提醒…</p>}>{alertsVisited ? <PerpetualAlerts active={active && alertsOpen} pair={alertPair} budget={qualityBudget} defaultOpen/> : null}</Suspense></div>
      <PerpetualCrossExSettings settings={crossex} now={now}/>
      <PerpetualFeeSettings budget={qualityBudget} onChange={next => { setInspection(null); setQualityBudget(next); }}/>
      <p className="perp-quality-caption">{qualityLoading ? "质量资料更新中" : qualityReport ? `质量资料最近读取 ${stamp(qualityReport.generatedAt)}` : "质量资料采集中"} · {quoteQuality.stale} 条报价过期 / {quoteQuality.unavailable} 条暂缺</p>
      {qualityError || qualityReport?.error ? <p className="perp-quality-notice" role="status">{qualityError || qualityReport?.error}</p> : null}
    </div></details>
    <details className="perp-method"><summary>计算口径与数据时间</summary><p>毛价差 =（做空平台价格 ÷ 做多平台价格 − 1）× 100%。买卖盘口取买入卖一、卖出买一；标记价格取两平台标记价。做多与做空必须来自不同在线平台，两腿价格时间相差不超过 5 秒；同一币种的所有有效平台与合约组合分别参与排名，按所选毛价差或净价差从高到低排列。净价差扣除双腿 taker 往返费与滑点预算，尚未计持有期资金费和退出价差；缺失费率的组合在净排序中置后，净价差显示缺失状态。</p><p>资金费差 = 做空腿费率 × 8 ÷ 该腿周期小时数 − 做多腿费率 × 8 ÷ 该腿周期小时数。正值表示按当前费率估算的净收入，负值为净支出；不是已结算收益。资金费或实际周期缺失、超过 5 分钟未更新时显示「—」。</p><p>资金费排序按 8 小时折算费差从高到低排列；开仓价差、资金费差和年化分别使用筛选面板中可见的范围，支持负值。24h 估算以单腿名义金额为基准，按两腿各自下次结算时间及周期计数，假设费率与入场价差不变，扣除往返 taker 手续费和滑点预算；不包含价差收益，也不代表已锁定利润。下次结算时间缺失或已过时，保留折算费差供比较，实际结算估算显示「—」。现有机会提醒仅按净价差触发。</p><p>过去 1 天 / 3 天只累计交易所真实已结算记录，分别取两腿共同截止时间前 24 / 72 小时，窗口为（截止 − 时长，截止]。净累计 = 空腿费率累计 − 多腿费率累计，分母为单腿等名义本金，不复利、不含交易成本，也不是账户实际收益。窗口前缺少真实结算记录或窗口内无记录时显示「—」，不以当前费率外推或补零；双腿合约与当前行方向一致。历史资料约每 5 分钟更新，过期或刷新失败时保留上次累计并标注状态。</p><p>价格超过 {(data?.staleAfterMs ?? 30_000) / 1000} 秒未更新会退出排名，成交价不会代替缺失盘口。报价时间取两腿较早的价格时间，所有时钟均为北京时间。毛价差未计手续费、滑点、深度和资金费；跨平台对冲仍存在成交差异。</p><p>筛选分权重：市值、市值 / FDV、官方多空拥挤度各 10%，近 1 小时价差持续性 10%，近 24 小时报价收窄证据 40%，资金费收入方向 20%。价差持续存在不代表会收窄；冷启动收窄统计至少积累 12 小时，且需 6 个完整 1h 窗口。只使用真实采样，缺失项不补零；资料不足时暂不评分，分数不代表盈利概率。质量、手续费和资金费差均对应当前行的做多与做空合约组合；净排序依据为扣费后的估算价差，质量分不代表成交容量。1h 历史偏离仅在至少 30 个有效样本、覆盖不低于 50% 时展示，1 bp = 0.01 个百分点。</p><p>每 5 分钟核对交易所公开合约目录；未标记不代表尚未公告，公开接口信息可能不完整。</p><p>最近快照 {stamp(data?.generatedAt)}。展开详情时保留当前列表、页码、平台组合及报价，并暂停本页行情接收；来源时间继续计时，过期值仅供核对。收起、翻页或修改筛选后恢复，后台采集与低频质量资料查询继续运行。页面每 20 秒应用最新行情，首次打开和手动刷新立即显示；后台保留连接，返回显示最新已接收数据。切换监控后暂停本页接收，服务器采集继续运行；推送中断时自动切换为每 20 秒快照，并尝试恢复推送。</p></details>
    </>}
  </section>;
}

export default memo(PerpetualPanel);
