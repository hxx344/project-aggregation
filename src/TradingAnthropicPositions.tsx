import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { BellRing, CircleAlert, KeyRound, LoaderCircle, Send } from 'lucide-react';
import { api, ApiError } from './api';
import type { AnthropicShares } from './trading-execution-types';
import { contractKey, findContract, sharesPerUnit } from './trading-anthropic';
import { amount, beijingTime, polarity } from './trading-format';
import TradingAnthropicReduction from './TradingAnthropicReduction';
import TradingPositionProtection from './TradingPositionProtection';
import type { PositionProtection } from './trading-anthropic-protection-types';

type Source = 'binance' | 'okx' | 'hyperliquid' | 'rh-lighter';
type ReadState = 'unconfigured' | 'loading' | 'live' | 'stale' | 'error';
type Position = {
  /** account: Lighter RH account index; an L1 address can hold several accounts. */
  id: string; exchange: Source; symbol: string; account?: number; side: 'long' | 'short'; quantity: string; quantityUnit: string | null; contractSize?: string;
  entryPrice: string | null; markPrice: string | null; notional: string | null; unrealizedPnl: string | null; leverage: string | null;
  marginMode: string | null; liquidationPrice: string | null; liquidationKnown?: boolean; distancePercent: string | null; riskUnknown?: boolean; alerting: boolean; protection?: PositionProtection | null;
};
type SourceState = { exchange: Source; connected: boolean; address?: string | null; accountMode?: string | null; accountIndex?: number | null; state: ReadState; fetchedAt: string | null; error: string | null; refreshing: boolean; positions: Position[] };
type AlertConfig = { enabled: boolean; thresholdPercent: number; repeatMinutes: number };
type HistoryEntry = { at: string; status: 'sent' | 'failed' | 'uncertain'; count: number; summary: string[]; error: string | null };
type WatchState = { generatedAt: string; sources: SourceState[]; alerts: { config: AlertConfig; channel: { configured: boolean; source: 'own' | 'digest' | null; host: string | null; error: string | null }; history: HistoryEntry[]; error: string | null; staleAfterSeconds: number; hysteresisPercent: number } };

const BASE = '/api/trading/anthropic';
const NAMES: Record<Source, string> = { binance: 'Binance', okx: 'OKX', hyperliquid: 'Hyperliquid', 'rh-lighter': 'Lighter RH' };
const STATES: Record<ReadState, string> = { unconfigured: '未连接', loading: '同步中', live: '已同步', stale: '数据已过期', error: '读取失败' };
const SCOPES: Record<string, string> = { standard: '标准合约', 'portfolio-margin': '组合保证金', cross: '全仓', isolated: '逐仓', agent: '主账户', 'api-key': '指定子账户' };
const UNCONNECTED: Record<Source, string> = { binance: '在「价差下单」连接 Binance 实盘账户后，自动读取同一账户仓位。', okx: '在「价差下单」连接 OKX 实盘账户后，自动读取同一账户仓位。', hyperliquid: '在「价差下单」连接 Hyperliquid 后，读取同一主账户仓位。', 'rh-lighter': '在「价差下单」连接 Lighter RH 后，仅读取该连接指定的子账户仓位。' };
const HISTORY: Record<HistoryEntry['status'], string> = { sent: '已发送', failed: '发送失败', uncertain: '结果未知' };
const formatDate = (value: string | null) => beijingTime(value);
const shareText = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: value < 100 ? 2 : 0 });

/** Estimated shares a leg stands for under the page's share-count assumption; null when unknown. */
function sharesOf(position: Position, shares: AnthropicShares) {
  const contract = findContract(contractKey(position as { exchange: Source; symbol: 'ANTHROPICUSDT' }));
  const perUnit = contract ? sharesPerUnit(contract, shares) : null;
  if (!perUnit) return null;
  return Number(position.quantity) * perUnit * (position.contractSize ? Number(position.contractSize) : 1);
}

export default function TradingAnthropicPositions({ shares, onExpired }: { shares: AnthropicShares; onExpired: () => void }) {
  const [data, setData] = useState<WatchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ enabled: boolean; threshold: string; repeat: string } | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'robot' | 'clear' | null>(null);
  const [robot, setRobot] = useState({ webhookUrl: '', signingSecret: '' });
  const [notice, setNotice] = useState<string | null>(null);
  // Save and test failures stay until the next write; the polling read clears only its own error.
  const [writeError, setWriteError] = useState<string | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine), [protectionPending, setProtectionPending] = useState(false);
  const [, setClock] = useState(0);
  const mounted = useRef(true), expires = useRef(onExpired), reading = useRef<AbortController | null>(null);
  const generation = useRef(0), writing = useRef(false), reductionWriting = useRef(false), receivedAt = useRef(0), transportMs = useRef(0);
  expires.current = onExpired;
  const accept = useCallback((value: WatchState, elapsed: number) => {
    receivedAt.current = performance.now(); transportMs.current = Math.max(0, elapsed);
    setData(value); setError(null); setProtectionPending(reductionWriting.current);
  }, []);

  const load = useCallback(async () => {
    if (reading.current || writing.current || reductionWriting.current || !navigator.onLine) return;
    const controller = new AbortController(), version = generation.current, started = performance.now(); reading.current = controller;
    try {
      const value = await api<WatchState>(BASE, { signal: controller.signal, timeoutMs: 12_000 });
      if (mounted.current && !controller.signal.aborted && version === generation.current) accept(value, performance.now() - started);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
      if (failure instanceof ApiError && failure.status === 401) expires.current();
      else setError(failure instanceof Error ? failure.message : 'Anthropic 仓位读取失败');
    } finally { if (reading.current === controller) reading.current = null; }
  }, [accept]);
  const reductionChanged = useCallback((pending: boolean) => {
    reductionWriting.current = pending; generation.current++; reading.current?.abort(); reading.current = null;
    setProtectionPending(true);
    if (!pending) void load();
  }, [load]);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => { void load(); timer = setTimeout(poll, document.hidden ? 60_000 : 10_000); };
    const wake = () => { setOffline(!navigator.onLine); setClock(value => value + 1); if (!document.hidden) { clearTimeout(timer); poll(); } };
    const disconnected = () => { setOffline(true); setProtectionPending(true); generation.current++; reading.current?.abort(); reading.current = null; };
    const clock = setInterval(() => { if (!document.hidden) setClock(value => value + 1); }, 1000);
    poll();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake); window.addEventListener('offline', disconnected);
    return () => { mounted.current = false; generation.current++; clearInterval(clock); clearTimeout(timer); reading.current?.abort(); reading.current = null; document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', disconnected); };
  }, [load]);

  const config = data?.alerts.config;
  const form = draft ?? (config ? { enabled: config.enabled, threshold: String(config.thresholdPercent), repeat: String(config.repeatMinutes) } : null);
  async function write(kind: 'save' | 'test' | 'robot' | 'clear', event?: FormEvent) {
    event?.preventDefault();
    if (!form || writing.current) return;
    writing.current = true; generation.current++; reading.current?.abort(); reading.current = null; setProtectionPending(true);
    const started = performance.now(), version = generation.current;
    setBusy(kind); setNotice(null); setWriteError(null);
    try {
      const value = kind === 'save'
        ? await api<WatchState>(`${BASE}/alerts`, { method: 'PUT', body: JSON.stringify({ config: { enabled: form.enabled, thresholdPercent: Number(form.threshold), repeatMinutes: Number(form.repeat) } }), timeoutMs: 15_000 })
        : kind === 'robot' ? await api<WatchState>(`${BASE}/alerts/channel`, { method: 'PUT', body: JSON.stringify(robot), timeoutMs: 15_000 })
        : kind === 'clear' ? await api<WatchState>(`${BASE}/alerts/channel/clear`, { method: 'POST', body: '{}', timeoutMs: 15_000 })
        : await api<WatchState>(`${BASE}/alerts/test`, { method: 'POST', body: '{}', timeoutMs: 20_000 });
      if (!mounted.current) return;
      if (version === generation.current) accept(value, performance.now() - started);
      else setProtectionPending(true);
      if (kind === 'save') setDraft(null);
      if (kind === 'robot') setRobot({ webhookUrl: '', signingSecret: '' });
      setNotice(kind === 'save' ? '预警设置已保存。' : kind === 'robot' ? '预警机器人已保存，建议发送一条测试确认。'
        : kind === 'clear' ? value.alerts.channel.configured ? '已改用「系统 → 飞书汇总」的机器人。' : '独立机器人已清除；飞书汇总也没有机器人，预警已停用。'
        : '测试消息已发送，请在飞书群确认。');
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && failure.status === 401) expires.current();
      else setWriteError(failure instanceof Error ? failure.message : '操作失败');
    } finally { writing.current = false; generation.current++; if (mounted.current) { setBusy(null); void load(); } }
  }

  const positions = data?.sources.flatMap(source => source.positions) ?? [];
  const estimates = positions.map(position => ({ position, shares: sharesOf(position, shares) }));
  const longShares = estimates.filter(item => item.position.side === 'long').reduce((sum, item) => sum + (item.shares ?? NaN), 0);
  const shortShares = estimates.filter(item => item.position.side === 'short').reduce((sum, item) => sum + (item.shares ?? NaN), 0);
  const threshold = config?.thresholdPercent ?? null;
  const dirty = !!draft && !!config && (draft.enabled !== config.enabled || Number(draft.threshold) !== config.thresholdPercent || Number(draft.repeat) !== config.repeatMinutes);
  const serverNow = data ? Date.parse(data.generatedAt) + transportMs.current + Math.max(0, performance.now() - receivedAt.current) : NaN;
  const protectionUnavailable = !!error || offline || protectionPending;

  return <section className="trading-panel trading-positions trading-anthropic-positions" aria-labelledby="trading-anthropic-title">
    <div className="trading-panel-heading"><div><h2 id="trading-anthropic-title">Anthropic 套利仓位</h2><p>四所统一使用「价差下单」的执行账户读取仓位 · Lighter RH 仅读取所连接子账户 · 每 30 秒只读刷新，强平距离按标记价计算</p></div></div>
    {!data ? <div className="trading-anthropic-loading" role="status">{error ? <span className="trading-warning">{error}</span> : <><LoaderCircle className="spin" size={20} /><span>正在读取 Anthropic 仓位…</span></>}</div> : <>
      <div className="trading-account-statuses">{data.sources.map(source => <div className="trading-account-status" key={source.exchange}>
        <div><strong>{NAMES[source.exchange]}</strong><span className={`trading-status ${source.state}`}><i aria-hidden="true" />{STATES[source.state]}</span>{source.refreshing ? <span className="trading-muted">后台同步中</span> : null}</div>
        <p>{source.connected ? <>仓位读取：{formatDate(source.fetchedAt)}{source.fetchedAt ? '（北京时间）' : ''}{source.accountMode ? ` · 下单账户 / ${SCOPES[source.accountMode] ?? source.accountMode}` : ''}{source.accountIndex == null ? '' : ` ${source.accountIndex}`}{source.address ? ` · ${source.address.slice(0, 6)}…${source.address.slice(-4)}` : ''}</> : UNCONNECTED[source.exchange]}</p>
        {source.error ? <p className="trading-warning">{source.error}</p> : null}
      </div>)}</div>
      {positions.length ? <div className="trading-position-scroll"><table className="trading-position-table" aria-label="Anthropic 仓位明细"><thead><tr>
        <th scope="col">合约 / 交易所</th><th scope="col">方向</th><th scope="col">数量<small>原生单位 · 估算股数</small></th><th scope="col">强平预警</th><th scope="col">自动减仓覆盖</th><th scope="col">开仓均价</th><th scope="col">标记价格</th>
        <th scope="col">名义价值</th><th scope="col">未实现盈亏</th><th scope="col">强平价</th><th scope="col">距强平</th><th scope="col">杠杆</th>
      </tr></thead><tbody>{estimates.map(({ position, shares: estimate }) => {
        const distance = position.distancePercent, near = distance !== null && threshold !== null && Number(distance) <= threshold;
        const riskUnknown = position.riskUnknown ?? (position.markPrice === null);
        return <tr key={position.id} className={`trading-leg-start${near || riskUnknown && position.alerting ? ' trading-anthropic-near' : ''}`} data-position-id={position.id}>
          <th scope="row" className="trading-leg-name"><strong>{position.symbol}</strong><span>{NAMES[position.exchange]}{position.account === undefined ? '' : ` · 账户 ${position.account}`}</span></th>
          <td data-label="方向"><span className={`trading-side ${position.side}`}>{position.side === 'long' ? '做多' : '做空'}</span></td>
          <td data-label="数量 · 估算股数">{amount(position.quantity)}{position.quantityUnit ? ` ${position.quantityUnit}` : ''}<small className="trading-anthropic-shares">{estimate === null ? '股数未知' : `≈ ${shareText(estimate)} 股`}</small></td>
          <td data-label="强平预警"><TradingPositionProtection value={position.protection?.alert} kind="alert" now={serverNow} unavailable={protectionUnavailable} /></td>
          <td data-label="自动减仓覆盖"><TradingPositionProtection value={position.protection?.reduction} kind="reduction" now={serverNow} unavailable={protectionUnavailable} /></td>
          <td data-label="开仓均价">{amount(position.entryPrice)}</td>
          <td data-label="标记价格">{amount(position.markPrice)}</td>
          <td data-label="名义价值">{amount(position.notional)}</td>
          <td data-label="未实现盈亏" className={polarity(position.unrealizedPnl)}>{amount(position.unrealizedPnl, true)}</td>
          <td data-label="强平价">{position.liquidationPrice === null ? <span className="trading-muted">未提供</span> : amount(position.liquidationPrice)}</td>
          <td data-label="距强平" className={near ? 'trading-negative' : ''}>{riskUnknown ? <span className="trading-warning">{position.liquidationKnown === false && Number(position.markPrice) > 0 ? '强平价缺失或无效，无法确认风险' : '标记价缺失，无法计算'}</span> : distance === null ? '—' : `${distance}%`}{position.alerting ? <small className="trading-anthropic-alerting">预警中</small> : null}</td>
          <td data-label="杠杆">{position.leverage ? `${amount(position.leverage)}×` : '—'}{position.marginMode ? ` ${position.marginMode === 'isolated' ? '逐仓' : position.marginMode === 'cross' ? '全仓' : position.marginMode}` : ''}</td>
        </tr>;
      })}</tbody></table></div> : <p className="trading-anthropic-empty">{data.sources.some(source => source.state === 'live') ? '已连接的账户当前没有 Anthropic 仓位。' : '尚无可确认的 Anthropic 仓位数据。'}</p>}
      {positions.length ? <div className={`trading-structure ${Number.isFinite(longShares) && Number.isFinite(shortShares) ? 'opposed' : 'incomplete'}`}><span>多空股数</span><strong>{Number.isFinite(longShares) && Number.isFinite(shortShares)
        ? `多头 ≈ ${shareText(longShares)} 股 · 空头 ≈ ${shareText(shortShares)} 股 · 差 ${shareText(Math.abs(longShares - shortShares))} 股（按「价差下单」中的股数假设 ${shares.outstanding}B / ${shares.diluted}B 估算）`
        : '股数假设无效，暂不估算多空股数'}</strong></div> : null}

    </>}
    <p className="trading-protection-note">覆盖按账户、原生合约和方向核对。预警仅发送提醒；减仓是否发送仍由最新风险与执行检查决定。检查时间为北京时间。</p>
    <TradingAnthropicReduction shares={shares} onExpired={onExpired} onStateChange={reductionChanged} />
    {data ? <>
      <div className="trading-anthropic-alerts">
        <h3><BellRing size={16} />强平预警 · 飞书</h3>
        {data.alerts.channel.error ? <p className="trading-warning" role="alert"><CircleAlert size={14} />{data.alerts.channel.error}</p>
          : !data.alerts.channel.configured ? <p className="trading-warning"><CircleAlert size={14} />尚未配置飞书机器人：在下方保存一个预警专用机器人，或在「系统 → 飞书汇总」配置后沿用。</p>
          : <p className="trading-anthropic-robot-status">发送到：{data.alerts.channel.source === 'own' ? `预警专用机器人（${data.alerts.channel.host}）` : '「系统 → 飞书汇总」的机器人'}</p>}
        <details className="trading-anthropic-robot">
          <summary>{data.alerts.channel.source === 'own' || data.alerts.channel.error ? '更换预警专用机器人' : '使用预警专用机器人'}</summary>
          <form className="trading-anthropic-robot-fields" onSubmit={event => void write('robot', event)}>
            <label>Webhook 地址<input type="password" value={robot.webhookUrl} onChange={event => setRobot({ ...robot, webhookUrl: event.target.value })} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…" autoComplete="off" /></label>
            <label>签名密钥（可选）<input type="password" value={robot.signingSecret} onChange={event => setRobot({ ...robot, signingSecret: event.target.value })} autoComplete="new-password" /></label>
            <small>在要接收预警的飞书群添加「自定义机器人」后获得；加密保存，不在页面回显。机器人开启「关键词」时，可设为「强平」或「预警」。</small>
            <div className="trading-anthropic-robot-actions">
              <button className="button primary" type="submit" disabled={!!busy || !robot.webhookUrl.trim()}>{busy === 'robot' ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}保存机器人</button>
              {data.alerts.channel.source === 'own' || data.alerts.channel.error ? <button className="button secondary" type="button" disabled={!!busy} onClick={() => void write('clear')}>{busy === 'clear' ? <LoaderCircle size={15} className="spin" /> : null}改用飞书汇总的机器人</button> : null}
            </div>
          </form>
        </details>
        <form onSubmit={event => void write('save', event)}>
        {form ? <div className="trading-anthropic-alert-fields">
          <label className="trading-anthropic-toggle"><input type="checkbox" checked={form.enabled} onChange={event => setDraft({ ...form, enabled: event.target.checked })} />启用预警</label>
          <label>距强平低于<span><input type="number" inputMode="decimal" min={1} max={90} step="any" value={form.threshold} onChange={event => setDraft({ ...form, threshold: event.target.value })} />%</span></label>
          <label>仍未解除时每隔<span><input type="number" inputMode="numeric" min={5} max={1440} step={1} value={form.repeat} onChange={event => setDraft({ ...form, repeat: event.target.value })} />分钟提醒</span></label>
          <button className="button primary" type="submit" disabled={!!busy || !dirty}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : null}保存</button>
          <button className="button secondary" type="button" disabled={!!busy || !data.alerts.channel.configured} onClick={() => void write('test')}>{busy === 'test' ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}发送测试</button>
        </div> : null}
        </form>
        <p className="trading-anthropic-rule">任一腿的距强平低于阈值时发送；距离回升到阈值以上 {data.alerts.hysteresisPercent} 个百分点后解除并通知。仓位从账户消失、或有仓位的账户超过 {Math.round(data.alerts.staleAfterSeconds / 60)} 分钟读不到新数据时也会提醒。交易所未提供强平价的仓位（如全仓保证金充足）不参与判断。</p>
        {error ? <p className="trading-warning" role="alert">{error}</p> : null}
        {writeError ? <p className="trading-warning" role="alert">{writeError}</p> : null}
        {data.alerts.error ? <p className="trading-warning" role="alert">{data.alerts.error}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {data.alerts.history.length ? <details className="trading-anthropic-history"><summary>最近发送（{data.alerts.history.length}）</summary><ul>{data.alerts.history.slice(0, 10).map(entry => <li key={entry.at}>
          <time dateTime={entry.at}>{formatDate(entry.at)}</time> · <span className={entry.status === 'sent' ? '' : 'trading-warning'}>{HISTORY[entry.status]}</span> · {entry.summary.join('；')}{entry.error ? `（${entry.error}）` : ''}
        </li>)}</ul></details> : null}
      </div>
      <p className="trading-footnote">强平价与标记价来自交易所账户接口；Hyperliquid 与 Lighter RH 标记价按仓位价值 ÷ 数量折算。估算股数沿用页面的股数假设，只用于核对多空是否大致相等。</p>
    </> : null}
  </section>;
}
