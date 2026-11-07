import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRightLeft, ChevronDown, CircleAlert, Clock3, Link2, LoaderCircle, RefreshCw, Square, Unplug } from 'lucide-react';
import { api, ApiError } from './api';
import { pairExchanges } from './trading-cache';
import type { TradingExchange, TradingPair } from './trading-types';
import type { AnthropicShares, ExecutionAccountMode, ExecutionAction, ExecutionConnection, ExecutionExchange, ExecutionJob, ExecutionLegInput, ExecutionMarket, ExecutionOrderType, ExecutionPlanInput, ExecutionPreset, ExecutionPreview, ExecutionSide, ExecutionState, ExecutionSubmission, ExecutionSymbol } from './trading-execution-types';
import { ANTHROPIC_CONTRACTS, contractKey, findContract, sharesProblem } from './trading-anthropic';
import { readTradingPreferences, saveTradingPreferences, TRADING_PAIRS } from './trading-preferences';
import type { ExecutionPreferences } from './trading-preferences';
import './trading-execution.css';

const BASE = '/api/trading/execution';
const EXCHANGES: Record<ExecutionExchange, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', hyperliquid: 'Hyperliquid', 'rh-lighter': 'Lighter RH' };
// Oil and SK hynix trade on the read-only venues only; Hyperliquid lists neither.
const PAIR_VENUES: TradingExchange[] = ['binance', 'bybit', 'okx'];
const MODES: Record<ExecutionAccountMode, string> = { standard: '普通 U 本位', 'portfolio-margin': '组合保证金', unified: '统一交易账户', cross: '全仓', isolated: '逐仓', agent: 'API 钱包', 'api-key': 'API Key' };
const MARKET_NAMES: Record<ExecutionMarket, string> = { oil: '原油', hynix: '海力士', anthropic: 'Anthropic' };
type PairMarket = Exclude<ExecutionMarket, 'anthropic'>;
// Oil hedges equal barrels; the SK hynix ADR/ordinary pair hedges equal USDT notional.
const MARKETS: Record<PairMarket, { name: string; symbols: [ExecutionSymbol, ExecutionSymbol]; labels: [string, string]; sizing: string; unit: string; hint: string }> = {
  oil: { name: '原油', symbols: ['CLUSDT', 'BZUSDT'], labels: ['CL', 'BZ'], sizing: '等桶', unit: '桶', hint: '每腿成交相同桶数，按各所每张合约桶数换算原生数量。' },
  hynix: { name: '海力士', symbols: ['SKHYUSDT', 'SKHYNIXUSDT'], labels: ['ADR', '正股'], sizing: '等金额', unit: 'USDT', hint: '每腿按预览盘口折算相同 USDT 名义金额，向下取整到下单步长；10 股 ADR 约对应 1 股正股。' },
};
// Same-venue first: it is the usual trade, so it is also the default preset.
const PRESETS: Record<ExecutionPreset, string> = { 'same-exchange': '同所两腿', 'four-leg': '四腿组合', 'cross-exchange': '跨所两腿' };
const STATUS: Record<ExecutionJob['status'], string> = { queued: '待执行', running: '执行中', stopping: '正在撤销余单', paused: '已暂停', attention: '待核对', completed: '已全部成交', stopped: '已停止' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? dateFormat.format(Date.parse(value)) : '尚未取得';
const seconds = (value: number) => `${value / 1000} 秒`;
const amount = (value: string | null) => {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return '—';
  const [integer, fraction] = value.split('.');
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : '.' + fraction}`;
};
const quantityUnit = (exchange: ExecutionExchange, unit?: string) => exchange === 'okx' ? '张' : unit || '原生合约单位';
const quoteAsset = (exchange: ExecutionExchange) => exchange === 'hyperliquid' ? 'USDC' : exchange === 'rh-lighter' ? 'USDG' : 'USDT';
const ANTHROPIC_SIZING = { sizing: '等股数', unit: '股', hint: '每腿按股数假设折算相同的估算股数（不是相同金额），向下取整到下单步长；各合约每单位折合股数见实时价差的 Anthropic 表。' };
const positive = (value: string) => /^\d+(?:\.\d{1,18})?$/.test(value) && /[1-9]/.test(value);
const direction = (side: ExecutionSide) => side === 'long' ? '多仓' : '空仓';
const orderSide = (action: ExecutionAction, side: ExecutionSide) => (action === 'open') === (side === 'long') ? 'buy' : 'sell';
const operation = (action: ExecutionAction, side: ExecutionSide) => `${orderSide(action, side) === 'buy' ? '买入' : '卖出'}${action === 'open' ? '开' : '平'}${side === 'long' ? '多' : '空'}`;
const legKey = (leg: Pick<ExecutionLegInput, 'exchange' | 'symbol'>) => `${leg.exchange}-${leg.symbol}`;
const terminal = (job: ExecutionJob) => job.status === 'completed' || job.status === 'stopped';
const TRACKING_STATUS: Record<ExecutionJob['status'], string> = {
  queued: '组合已受理，正在等待执行。', running: '组合正在成交，持续跟踪各腿进度。',
  stopping: '正在撤销余单并核对成交，尚未结束。', paused: '组合已暂停，尚未全部成交；请核对原因后决定是否继续剩余数量。',
  attention: '组合待核对，尚不能确认完成；请核对下方委托状态。',
  completed: '组合已全部成交，成交结果保留如下。', stopped: '组合已停止，已成交仓位保留；未成交数量不会继续执行。',
};
// Display progress only: exact decimals prevent a small remainder rounding up to 100%.
const fillPercent = (filled: string, target: string) => {
  const scaled = (value: string) => { const [integer, fraction = ''] = value.split('.'); return BigInt(integer + fraction.padEnd(18, '0')); };
  if (![filled, target].every(value => /^\d+(?:\.\d{1,18})?$/.test(value)) || !positive(target)) return '—';
  const tenths = scaled(filled) * 1000n / scaled(target);
  return `${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ''}%`;
};
type LegStructure = Pick<ExecutionLegInput, 'exchange' | 'symbol' | 'side'>;
type MutationResult<T> = { ok: true; value: T } | { ok: false; error?: unknown };
type Write = (suffix: string, body: object, method?: 'POST' | 'PUT' | 'DELETE') => Promise<boolean>;

/** Anthropic legs are two chosen contracts; the preset follows from whether they share a venue. */
function anthropicPreset(keys: [string, string]): ExecutionPreset { return findContract(keys[0])?.exchange === findContract(keys[1])?.exchange ? 'same-exchange' : 'cross-exchange'; }
function structure(market: ExecutionMarket, preset: ExecutionPreset, exchange: TradingExchange, symbol: ExecutionSymbol, reverse: boolean, pair: TradingPair, anthropic: [string, string]): LegStructure[] {
  const first: ExecutionSide = reverse ? 'short' : 'long', second: ExecutionSide = reverse ? 'long' : 'short';
  if (market === 'anthropic') return anthropic.map((key, index) => { const contract = findContract(key)!; return { exchange: contract.exchange, symbol: contract.symbol, side: index === 0 ? first : second }; });
  const [left, right] = pairExchanges(pair), [a, b] = MARKETS[market].symbols;
  if (preset === 'same-exchange') return [{ exchange, symbol: a, side: first }, { exchange, symbol: b, side: second }];
  if (preset === 'cross-exchange') return [{ exchange: left, symbol, side: first }, { exchange: right, symbol, side: second }];
  return [{ exchange: left, symbol: a, side: first }, { exchange: left, symbol: b, side: second }, { exchange: right, symbol: a, side: second }, { exchange: right, symbol: b, side: first }];
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return <div className="execution-choice"><span aria-hidden="true">{label}</span><div className="execution-segmented" role="group" aria-label={label}>{options.map(([key, text]) => <button key={key} type="button" aria-pressed={value === key} onClick={() => { if (value !== key) onChange(key); }}>{text}</button>)}</div></div>;
}
const ORDER_TYPES: [ExecutionOrderType, string][] = [['chase', '追价限价'], ['market', '市价']];
const orderBadge = (legs: { orderType: ExecutionOrderType }[]) => legs.every(leg => leg.orderType === 'market') ? '市价 · 吃单' : legs.some(leg => leg.orderType === 'market') ? '追价限价 + 市价' : '限价 · 仅挂单';
const limitText = (leg: { orderType: ExecutionOrderType; orderSide: 'buy' | 'sell'; stopPrice: string | null }) => leg.orderType === 'market' ? <>市价<small>不设价格界限</small></> : leg.stopPrice === null ? <>不设界限<small>一直跟随盘口</small></> : <>{leg.orderSide === 'buy' ? '≤ ' : '≥ '}{amount(leg.stopPrice)}<small>{leg.orderSide === 'buy' ? '买单上限' : '卖单下限'}</small></>;
const batchSummary = (quantities: string[]) => quantities.every(quantity => quantity === quantities[0]) ? `${quantities.length} 批 × ${amount(quantities[0])}` : quantities.map(amount).join(' / ');

const WALLET_ADDRESS = /^0x[0-9a-fA-F]{40}$/, WALLET_KEY = /^0x[0-9a-fA-F]{64}$/;
/** Hyperliquid signs with an API (agent) wallet approved by the master account; it cannot transfer or withdraw. */
const WalletConnectionForm = memo(function WalletConnectionForm({ connection, disabled, write }: { connection: ExecutionConnection; disabled: boolean; write: Write }) {
  const [address, setAddress] = useState(''), [agentKey, setAgentKey] = useState('');
  const locked = disabled || connection.locked, valid = WALLET_ADDRESS.test(address.trim()) && WALLET_KEY.test(agentKey.trim());
  async function save(event: FormEvent) {
    event.preventDefault();
    const body = { revision: connection.revision, accountMode: 'agent', address: address.trim(), agentKey: agentKey.trim() };
    setAgentKey('');
    if (await write(`/accounts/${connection.exchange}`, body, 'PUT')) setAddress('');
  }
  return <form className="execution-connection" onSubmit={save} aria-label="Hyperliquid 实盘账户连接">
    <div className="execution-connection-title"><h4>Hyperliquid</h4><span className={`execution-badge ${connection.connected ? 'connected' : ''}`}>{connection.connected ? '已连接' : '未连接'}</span></div>
    {connection.connected ? <p className="execution-account-identity">API 钱包 · 主账户 {connection.identity ?? '未返回'} · API 钱包地址尾号 {connection.keyLabel ?? '未返回'}<small>验证时间：{date(connection.verifiedAt)}（北京时间）</small></p>
      : <p className="execution-help">在 Hyperliquid 的 API 页面创建 API 钱包并授权给主账户。这里只填写 API 钱包私钥，不要填写主钱包私钥；API 钱包只能下单和撤单，不能转账或提现；请专用于本系统，与其他程序共用会造成请求编号冲突而被拒单。交易 io:ANTH（Entropy）与 xyz:ANT（trade.xyz），按账户当前杠杆成交，本系统不修改杠杆。</p>}
    {connection.locked ? <p className="execution-warning">存在未结束或待核对的执行，完成对账前不能替换或断开连接。</p> : null}
    <fieldset disabled={locked}>
      <label>Hyperliquid 主账户地址<input type="text" autoComplete="off" spellCheck={false} maxLength={42} placeholder="0x 开头 40 位十六进制" value={address} onChange={event => setAddress(event.target.value)} required /></label>
      <label>Hyperliquid API 钱包私钥<input type="password" name="hyperliquid-agent-key" autoComplete="new-password" spellCheck={false} maxLength={66} placeholder="0x 开头 64 位十六进制" value={agentKey} onChange={event => setAgentKey(event.target.value)} required /></label>
      {address.trim() && !WALLET_ADDRESS.test(address.trim()) ? <p className="execution-warning">主账户地址须为 0x 开头的 40 位十六进制。</p> : null}
      <div className="execution-actions"><button className="button primary" type="submit" disabled={!valid}><Link2 size={15} />{connection.connected ? '验证并替换实盘连接' : '验证并连接实盘账户'}</button>{connection.connected ? <button className="button secondary" type="button" onClick={() => { setAgentKey(''); void write(`/accounts/${connection.exchange}`, { revision: connection.revision }, 'DELETE'); }}><Unplug size={15} />断开</button> : null}</div>
    </fieldset>
  </form>;
});

const LIGHTER_KEY = /^(?:0x)?[0-9a-fA-F]{80}$/, LIGHTER_INDEX = /^\d{1,15}$/;
const lighterKeyIndex = (value: string) => LIGHTER_INDEX.test(value) && Number(value) >= 4 && Number(value) <= 254 && Number(value) !== 157;
/** Lighter on Robinhood Chain signs with an account API key (index 4–254) registered to the L1 wallet's account. */
const LighterConnectionForm = memo(function LighterConnectionForm({ connection, disabled, write }: { connection: ExecutionConnection; disabled: boolean; write: Write }) {
  const [address, setAddress] = useState(''), [accountIndex, setAccountIndex] = useState(''), [apiKeyIndex, setApiKeyIndex] = useState(''), [apiKey, setApiKey] = useState('');
  const locked = disabled || connection.locked;
  const valid = WALLET_ADDRESS.test(address.trim()) && LIGHTER_INDEX.test(accountIndex.trim()) && Number(accountIndex.trim()) >= 1 && lighterKeyIndex(apiKeyIndex.trim()) && LIGHTER_KEY.test(apiKey.trim());
  async function save(event: FormEvent) {
    event.preventDefault();
    const body = { revision: connection.revision, accountMode: 'api-key', address: address.trim(), accountIndex: accountIndex.trim(), apiKeyIndex: apiKeyIndex.trim(), apiKey: apiKey.trim() };
    setApiKey('');
    if (await write(`/accounts/${connection.exchange}`, body, 'PUT')) { setAddress(''); setAccountIndex(''); setApiKeyIndex(''); }
  }
  return <form className="execution-connection" onSubmit={save} aria-label="Lighter RH 实盘账户连接">
    <div className="execution-connection-title"><h4>Lighter RH</h4><span className={`execution-badge ${connection.connected ? 'connected' : ''}`}>{connection.connected ? '已连接' : '未连接'}</span></div>
    {connection.connected ? <p className="execution-account-identity">API Key · 钱包 {connection.identity ?? '未返回'} · 账户#密钥索引 {connection.keyLabel ?? '未返回'}<small>验证时间：{date(connection.verifiedAt)}（北京时间）</small></p>
      : <p className="execution-help">在 robinhoodchain.lighter.xyz 的 API Keys 页面为账户创建 API Key，填写钱包地址、账户索引、API Key 索引与 API 私钥（不是钱包私钥）。本系统只用它下单和撤单；请为本系统单独使用一个 API Key 索引，与其他程序共用会造成 nonce 冲突而被拒单。交易 ANTHROPIC（USDG 结算），按账户当前杠杆成交，本系统不修改杠杆。钱包地址同时用于「套利仓位」标签中 Anthropic 仓位与强平预警的读取。</p>}
    {connection.locked ? <p className="execution-warning">存在未结束或待核对的执行，完成对账前不能替换或断开连接。</p> : null}
    <fieldset disabled={locked}>
      <label>Lighter 钱包地址（L1）<input type="text" autoComplete="off" spellCheck={false} maxLength={42} placeholder="0x 开头 40 位十六进制" value={address} onChange={event => setAddress(event.target.value)} required /></label>
      <label>Lighter 账户索引<input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={15} placeholder="例如 22163" value={accountIndex} onChange={event => setAccountIndex(event.target.value)} required /></label>
      <label>Lighter API Key 索引<input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={3} placeholder="4–254" value={apiKeyIndex} onChange={event => setApiKeyIndex(event.target.value)} required /></label>
      <label>Lighter API 私钥<input type="password" name="rh-lighter-api-key" autoComplete="new-password" spellCheck={false} maxLength={82} placeholder="80 位十六进制" value={apiKey} onChange={event => setApiKey(event.target.value)} required /></label>
      {address.trim() && !WALLET_ADDRESS.test(address.trim()) ? <p className="execution-warning">钱包地址须为 0x 开头的 40 位十六进制。</p> : null}
      {apiKeyIndex.trim() && !lighterKeyIndex(apiKeyIndex.trim()) ? <p className="execution-warning">API Key 索引须为 4 到 254 的整数（157 除外）。</p> : null}
      <div className="execution-actions"><button className="button primary" type="submit" disabled={!valid}><Link2 size={15} />{connection.connected ? '验证并替换实盘连接' : '验证并连接实盘账户'}</button>{connection.connected ? <button className="button secondary" type="button" onClick={() => { setApiKey(''); void write(`/accounts/${connection.exchange}`, { revision: connection.revision }, 'DELETE'); }}><Unplug size={15} />断开</button> : null}</div>
    </fieldset>
  </form>;
});

const ConnectionForm = memo(function ConnectionForm({ connection, disabled, write }: { connection: ExecutionConnection; disabled: boolean; write: Write }) {
  const [mode, setMode] = useState<ExecutionAccountMode>(connection.exchange === 'okx' ? connection.accountMode === 'isolated' ? 'isolated' : 'cross' : connection.accountMode);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const name = EXCHANGES[connection.exchange], locked = disabled || connection.locked;
  async function save(event: FormEvent) {
    event.preventDefault();
    const body = { revision: connection.revision, accountMode: mode, apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), ...(connection.exchange === 'okx' ? { passphrase: passphrase.trim() } : {}) };
    setPassphrase('');
    if (await write(`/accounts/${connection.exchange}`, body, 'PUT')) { setApiKey(''); setApiSecret(''); }
  }
  return <form className="execution-connection" onSubmit={save} aria-label={`${name} 实盘账户连接`}>
    <div className="execution-connection-title"><h4>{name}</h4><span className={`execution-badge ${connection.connected ? 'connected' : ''}`}>{connection.connected ? '已连接' : '未连接'}</span></div>
    {connection.connected ? <p className="execution-account-identity">{MODES[connection.accountMode]} · UID {connection.identity ?? '未返回'} · 密钥尾号 {connection.keyLabel ?? '未返回'}<small>验证时间：{date(connection.verifiedAt)}（北京时间）</small></p> : <p className="execution-help">连接允许合约交易、关闭提现和转账权限的独立密钥。</p>}
    {connection.locked ? <p className="execution-warning">存在未结束或待核对的执行，完成对账前不能替换或断开连接。</p> : null}
    <fieldset disabled={locked}>
      {connection.exchange === 'binance' ? <label>Binance 实盘账户模式<select value={mode} onChange={event => setMode(event.target.value as ExecutionAccountMode)}><option value="standard">普通 U 本位</option><option value="portfolio-margin">组合保证金（Portfolio Margin）</option></select></label> : null}
      {connection.exchange === 'okx' ? <label>OKX 实盘保证金模式<select value={mode} onChange={event => setMode(event.target.value as ExecutionAccountMode)}><option value="cross">全仓</option><option value="isolated">逐仓</option></select></label> : null}
      <label>{name} 实盘 API Key<input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={event => setApiKey(event.target.value)} required /></label>
      <label>{name} 实盘 API Secret<input type="password" autoComplete="off" spellCheck={false} value={apiSecret} onChange={event => setApiSecret(event.target.value)} required /></label>
      {connection.exchange === 'okx' ? <label>OKX 实盘 Passphrase<input type="password" autoComplete="off" spellCheck={false} value={passphrase} onChange={event => setPassphrase(event.target.value)} required /></label> : null}
      <div className="execution-actions"><button className="button primary" type="submit" disabled={!apiKey.trim() || !apiSecret.trim() || connection.exchange === 'okx' && !passphrase.trim()}><Link2 size={15} />{connection.connected ? '验证并替换实盘连接' : '验证并连接实盘账户'}</button>{connection.connected ? <button className="button secondary" type="button" onClick={() => { setPassphrase(''); void write(`/accounts/${connection.exchange}`, { revision: connection.revision }, 'DELETE'); }}><Unplug size={15} />断开</button> : null}</div>
    </fieldset>
  </form>;
});

const JobCard = memo(function JobCard({ job, disabled, canPreview, write, resume }: { job: ExecutionJob; disabled: boolean; canPreview: boolean; write: Write; resume: (id: string) => void }) {
  const [strategyIds, setStrategyIds] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [absent, setAbsent] = useState<Record<string, boolean>>({});
  return <article className={`execution-job ${job.status}`} aria-label={`${MARKET_NAMES[job.market]}${PRESETS[job.preset]}${job.action === 'open' ? '开仓' : '平仓'} ${STATUS[job.status]}`}>
    <header><div><h3>{MARKET_NAMES[job.market]}{PRESETS[job.preset]}{job.action === 'open' ? '开仓' : '平仓'} <span className={`execution-badge ${job.status}`}>{STATUS[job.status]}</span>{job.auto ? <span className="execution-badge">自动规则触发</span> : null}</h3><p>第 {Math.min(job.batchIndex + 1, job.batchCount)} / {job.batchCount} 批 · 更新于 {date(job.updatedAt)}（北京时间）</p></div>{!terminal(job) && job.status !== 'stopping' ? <button className="button secondary execution-stop" type="button" disabled={disabled} onClick={() => void write(`/jobs/${encodeURIComponent(job.id)}/stop`, {})}><Square size={14} />停止并撤销余单</button> : null}</header>
    {job.reason ? <p className="execution-job-reason" role={job.status === 'attention' ? 'alert' : undefined}>{job.reason}</p> : null}
    <div className="execution-table-wrap"><table className="execution-progress-table"><thead><tr><th scope="col">交易腿</th><th scope="col">已成交 / 目标<small>原生合约单位</small></th><th scope="col">剩余数量</th><th scope="col">当前委托 / 策略</th><th scope="col">最后对账<small>北京时间</small></th></tr></thead><tbody>{job.legs.map(leg => <tr key={leg.id}>
      <th scope="row"><strong>{EXCHANGES[leg.exchange]} {leg.symbol}</strong><span className={`execution-side ${leg.side}`}>{operation(job.action, leg.side)}</span></th>
      <td data-label="已成交 / 目标"><span><strong>{amount(leg.filledQuantity)}</strong> / {amount(leg.quantity)}{leg.exchange === 'okx' ? ' 张' : ''}<small>成交进度 {fillPercent(leg.filledQuantity, leg.quantity)}</small></span></td><td data-label="剩余数量">{amount(leg.remainingQuantity)}{leg.exchange === 'okx' ? ' 张' : ''}</td>
      <td data-label="当前委托 / 策略">{leg.currentOrder ? <><span className={leg.currentOrder.unknown ? 'execution-warning' : ''}>{leg.currentOrder.unknown ? '结果未知，等待核对' : leg.currentOrder.state}</span><small>{leg.currentOrder.kind === 'strategy' ? 'Bybit 原生追逐' : leg.orderType === 'market' ? `${EXCHANGES[leg.exchange]} 市价单` : `${EXCHANGES[leg.exchange]} 同向价一`}{leg.currentOrder.price ? ` · 委托价 ${amount(leg.currentOrder.price)} ${quoteAsset(leg.exchange)}` : ''}</small>{leg.currentOrder.id || leg.currentOrder.kind !== 'strategy' && leg.currentOrder.clientId ? <small style={{ maxWidth: '26ch', marginLeft: 'auto', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{leg.currentOrder.id ? `${leg.currentOrder.kind === 'strategy' ? '策略' : '订单'} ID：${leg.currentOrder.id}` : `客户单号：${leg.currentOrder.clientId}`}</small> : null}</> : '尚无活动委托'}</td>
      <td data-label="最后对账">{date(leg.currentOrder?.lastCheckedAt ?? null)}</td>
    </tr>)}</tbody></table></div>
    {job.legs.filter(leg => leg.currentOrder?.unknown).map(leg => {
      const needsId = leg.currentOrder?.kind === 'strategy' && !leg.currentOrder.id;
      return <form key={leg.id} className="execution-reconcile" onSubmit={event => { event.preventDefault(); void write(`/jobs/${encodeURIComponent(job.id)}/reconcile`, { legId: leg.id, ...(needsId ? { strategyId: (strategyIds[leg.id] || '').trim(), acknowledge: true } : {}) }); }}>
        <strong>{EXCHANGES[leg.exchange]} {leg.symbol} · {operation(job.action, leg.side)}</strong>
        {needsId ? <><p>请在 Bybit 核对该账户、合约、方向与数量，填写对应追逐策略 ID。核对后将停止该策略的余单。</p><label>对应策略 ID<input type="text" autoComplete="off" spellCheck={false} maxLength={100} required value={strategyIds[leg.id] || ''} onChange={event => setStrategyIds(current => ({ ...current, [leg.id]: event.target.value }))} disabled={disabled} /></label><label className="execution-checkbox"><input type="checkbox" checked={!!acknowledged[leg.id]} onChange={event => setAcknowledged(current => ({ ...current, [leg.id]: event.target.checked }))} required disabled={disabled} />我已核对这是此交易腿提交的策略</label></> : <p>先向交易所核对实际状态；结果未知期间不会重复提交。</p>}
        <button className="button secondary" type="submit" disabled={disabled || needsId && (!acknowledged[leg.id] || !strategyIds[leg.id]?.trim())}><RefreshCw size={14} />{needsId ? '核对并停止策略余单' : '重新核对'}</button>
        {needsId && ['attention', 'paused'].includes(job.status) ? <><p>若 Bybit 该合约没有运行中的追逐策略、下单前后也没有新建策略，可确认本次策略未创建{leg.currentOrder?.confirmAfter ? `（${date(leg.currentOrder.confirmAfter)} 后可确认）` : ''}。</p><label className="execution-checkbox"><input type="checkbox" checked={!!absent[leg.id]} onChange={event => setAbsent(current => ({ ...current, [leg.id]: event.target.checked }))} disabled={disabled} />我已在 Bybit 核对，没有对应的追逐策略</label>
          <button className="button secondary" type="button" disabled={disabled || !absent[leg.id]} onClick={() => void write(`/jobs/${encodeURIComponent(job.id)}/reconcile`, { legId: leg.id, notCreated: true, acknowledge: true })}>确认策略未创建</button></> : null}
      </form>;
    })}
    <footer><span>停止只撤销余单，已成交仓位保留。</span>{job.canResume ? <button className="button secondary" type="button" disabled={disabled || !canPreview} onClick={() => resume(job.id)}>预览继续剩余</button> : null}</footer>
    <details className="execution-events"><summary>执行记录与编号</summary><p>执行编号：{job.id} · 最晚结束：{date(job.deadlineAt)}（北京时间）</p><ul>{job.events.map((event, index) => <li key={`${event.time}-${index}`}><time>{date(event.time)}</time><span>{event.message}</span></li>)}</ul></details>
  </article>;
});

const Preview = memo(function Preview({ preview, expired, disabled, uncertain, onSubmit, onEdit }: { preview: ExecutionPreview; expired: boolean; disabled: boolean; uncertain: boolean; onSubmit: () => void; onEdit: () => void }) {
  return <section className="execution-review" aria-labelledby="execution-review-title" tabIndex={-1}>
    <div className="execution-review-title"><div><h3 id="execution-review-title">确认{preview.resumeJobId ? '剩余数量的' : ''}{MARKET_NAMES[preview.market]}{PRESETS[preview.preset]}{preview.action === 'open' ? '开仓' : '平仓'}</h3><p>预览有效至 {date(preview.expiresAt)}（北京时间）</p></div><span className="execution-badge connected">{orderBadge(preview.legs)}</span></div>
    <div className="execution-review-accounts">{preview.connections.map(connection => <p key={connection.exchange}><strong>{EXCHANGES[connection.exchange]}</strong> {MODES[connection.accountMode]} · {connection.exchange === 'hyperliquid' ? '主账户' : connection.exchange === 'rh-lighter' ? '钱包' : 'UID'} {connection.identity ?? '未返回'} · {connection.exchange === 'hyperliquid' ? 'API 钱包地址尾号' : connection.exchange === 'rh-lighter' ? '账户#密钥索引' : '密钥尾号'} {connection.keyLabel ?? '未返回'}</p>)}</div>
    {preview.shares ? <p className="execution-help">股数假设：流通 {amount(preview.shares.outstanding)} 十亿股 · 完全稀释 {amount(preview.shares.diluted)} 十亿股{preview.equalSize ? ` · 每腿目标 ${amount(preview.equalSize)} 股` : ''}</p> : null}
    <dl className="execution-review-settings"><div><dt>批次</dt><dd>{preview.batchCount} 批</dd></div><div><dt>批间等待</dt><dd>{seconds(preview.batchIntervalMs)}</dd></div><div><dt>本地追价间隔（Binance / OKX / Hyperliquid / Lighter RH）</dt><dd>{seconds(preview.repriceIntervalMs)}</dd></div><div><dt>最长执行</dt><dd>{seconds(preview.timeoutMs)}</dd></div></dl>
    <div className="execution-review-legs execution-table-wrap"><table className="execution-progress-table execution-review-table"><thead><tr><th scope="col">交易腿</th><th scope="col">数量</th><th scope="col">估算名义<small>USDT / USDC</small></th><th scope="col">当前该方向<small>持仓模式 · 杠杆</small></th><th scope="col">下单方式 / 界限<small>USDT / USDC</small></th><th scope="col">买一 / 卖一<small>盘口时间</small></th><th scope="col">分批</th></tr></thead><tbody>{preview.legs.map(leg => <tr key={leg.id}>
      <th scope="row"><strong>{EXCHANGES[leg.exchange]} {leg.rule?.instrumentId ?? leg.symbol}</strong><span className={`execution-side ${leg.side}`}>{operation(preview.action, leg.side)}</span></th>
      <td data-label="数量"><strong>{amount(leg.quantity)}</strong> {quantityUnit(leg.exchange, leg.rule?.quantityUnit)}{leg.exchange === 'okx' ? <small>每张 {amount(leg.rule?.contractSize ?? null)}</small> : null}</td>
      <td data-label="估算名义">{amount(leg.estimatedNotional)}<small>{leg.rule?.quoteAsset ?? 'USDT'}</small></td>
      <td data-label="当前持仓">{amount(leg.currentQuantity)}<small>{leg.positionMode === 'hedge' ? '双向' : '单向'}{leg.leverage ? ` · ${leg.leverage.type === 'isolated' ? '逐仓' : '全仓'} ${leg.leverage.value}x（不修改）` : ''}</small></td>
      <td data-label="下单方式 / 界限">{limitText(leg)}</td>
      <td data-label="买一 / 卖一">{amount(leg.bid)} / {amount(leg.ask)}<small>{date(leg.quoteAt)}</small></td>
      <td data-label="分批">{batchSummary(leg.batchQuantities)}</td>
    </tr>)}</tbody></table></div>
    <p className="execution-help">追价限价：Bybit 使用原生追逐限价单，按本方一档追价；Binance 与 OKX 由服务定时按同向价一追价并修改原订单；OKX 使用 post_only 仅挂单。达到追价界限时停止追价并撤销余单；界限不是严格成交限价，盘口瞬时跳价仍可能越过它。Hyperliquid 以只挂单（ALO）挂在同侧最优价，价格变化时撤销原订单、确认结束后按剩余数量重新挂单；Lighter RH 同样以只挂单（post-only）挂单并撤单重挂，追价间隔至少 5 秒。市价：每批发送一次普通市价单（Hyperliquid 与 Lighter RH 为对手价 ±1% 的 IOC 委托），立即按对手盘成交，成交价可能明显偏离预览盘口。OKX 名义金额按张数 × 合约乘数 × 价格估算。</p>
    {preview.notes.length ? <ul className="execution-review-notes">{preview.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
    {uncertain ? <p className="execution-warning" role="alert">本次提交结果尚未确认。请用下方按钮核对同一次提交，不要重复创建组合。</p> : expired ? <p className="execution-warning" role="status">预览已过期，请重新获取盘口与持仓后确认。</p> : null}
    <div className="execution-actions"><button className="button primary" type="button" disabled={disabled || expired && !uncertain} onClick={onSubmit}>{disabled ? <LoaderCircle size={16} className="spin" /> : <ArrowRightLeft size={16} />}{uncertain ? '重新核对本次提交' : `确认并一键${preview.action === 'open' ? '开仓' : '平仓'}`}</button><button className="button secondary" type="button" disabled={disabled || uncertain} onClick={onEdit}>返回修改参数</button></div>
  </section>;
});

export default function TradingExecution({ pair, onPair, onExpired, shares, onShares }: { pair: TradingPair; onPair: (value: TradingPair) => void; onExpired: () => void; shares: AnthropicShares; onShares: (value: AnthropicShares) => void }) {
  const [state, setState] = useState<ExecutionState | null>(null);
  const [trackedJob, setTrackedJob] = useState<ExecutionJob | null>(null);
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [readError, setReadError] = useState(''), [writeError, setWriteError] = useState(''), [notice, setNotice] = useState('');
  const [offline, setOffline] = useState(!navigator.onLine), [expiredSession, setExpiredSession] = useState(false);
  const [preferences, setPreferences] = useState(() => readTradingPreferences(pair));
  const market = preferences.market;
  const { preset, action, sizeMode, selectedExchange, selectedSymbol, orientation, anthropicKeys, orderTypes, batchCount, batchInterval, repriceInterval, timeout, advanced } = preferences.profiles[market];
  const updatePreferences = (patch: Partial<ExecutionPreferences>) => setPreferences(current => ({ ...current, profiles: { ...current.profiles, [current.market]: { ...current.profiles[current.market], ...patch, pair } } }));
  useEffect(() => { saveTradingPreferences(preferences); }, [preferences]);
  const [equalSize, setEqualSize] = useState('');
  const [values, setValues] = useState<Record<string, { quantity: string; stopPrice: string; orderType: ExecutionOrderType }>>({});
  const [storedReview, setReview] = useState<{ preview: ExecutionPreview; requestId: string; uncertain: boolean; pair: TradingPair } | null>(null);
  const review = storedReview?.pair === pair ? storedReview : null;
  const [draftPair, setDraftPair] = useState(pair);
  const [, setClock] = useState(0);
  const mounted = useRef(false), busyRef = useRef(false), readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null);
  const responseVersion = useRef(0), lastSuccess = useRef<number | null>(null), expiresHandler = useRef(onExpired);
  const connectionsRef = useRef<HTMLDetailsElement>(null), reviewRef = useRef<HTMLDivElement>(null);
  const trackingRef = useRef<HTMLElement>(null), focusTracking = useRef(false);
  const trackedJobId = useRef<string | null>(null);
  trackedJobId.current = trackedJob?.id ?? null;
  expiresHandler.current = onExpired;
  const pairRef = useRef(pair);
  const pairVersion = useRef(0);
  pairRef.current = pair;
  // Reset before children commit, so a new pair never exposes the old direction or preview.
  if (draftPair !== pair) { pairVersion.current++; setDraftPair(pair); updatePreferences({ orientation: '' }); setValues({}); setEqualSize(''); setReview(null); setWriteError(''); setNotice(''); }
  const acceptState = useCallback((value: ExecutionState) => {
    lastSuccess.current = performance.now(); setState(value); setReadError('');
    setTrackedJob(current => current ? value.jobs.find(job => job.id === current.id) ?? current : value.jobs.find(job => !job.auto) ?? null);
  }, []);
  const expire = useCallback(() => { if (!mounted.current) return; readController.current?.abort(); writeController.current?.abort(); setState(null); setTrackedJob(null); setReview(null); setExpiredSession(true); expiresHandler.current(); }, []);
  const load = useCallback(async (force = false) => {
    if (!mounted.current || busyRef.current || !navigator.onLine) return;
    if (readController.current) { if (!force) return; readController.current.abort(); }
    const controller = new AbortController(), version = responseVersion.current;
    readController.current = controller; setReading(true);
    try {
      const value = await api<ExecutionState>(BASE + (trackedJobId.current ? `?jobId=${encodeURIComponent(trackedJobId.current)}` : ''), { signal: controller.signal, timeoutMs: 12_000 });
      if (mounted.current && !controller.signal.aborted && version === responseVersion.current) acceptState(value);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) expire();
      else setReadError(error instanceof Error ? error.message : '执行状态读取失败');
    } finally { if (readController.current === controller) { readController.current = null; if (mounted.current) setReading(false); } }
  }, [acceptState, expire]);
  useEffect(() => {
    let disposed = false;
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelResume = () => { clearTimeout(resumeTimer); resumeTimer = undefined; };
    const schedulePoll = () => {
      clearTimeout(timer); timer = undefined;
      if (!disposed) timer = setTimeout(poll, document.hidden ? 30_000 : 3000);
    };
    const poll = () => {
      if (disposed) return;
      if (resumeTimer === undefined) void load();
      schedulePoll();
    };
    const wake = () => {
      if (disposed) return;
      setOffline(!navigator.onLine);
      if (document.hidden) { cancelResume(); if (timer === undefined) schedulePoll(); return; }
      if (navigator.onLine && resumeTimer === undefined) {
        clearTimeout(timer); timer = undefined;
        const previousRead = readController.current;
        // Replace only the read that predates this coalesced recovery window.
        resumeTimer = setTimeout(() => {
          resumeTimer = undefined;
          if (disposed) return;
          if (navigator.onLine) void load(previousRead !== null && readController.current === previousRead);
          schedulePoll();
        }, 1000);
      }
    };
    const disconnected = () => {
      if (disposed) return;
      cancelResume(); setOffline(true); readController.current?.abort(); schedulePoll();
    };
    poll();
    const clock = setInterval(() => { if (!disposed) setClock(value => value + 1); }, 3000);
    document.addEventListener('visibilitychange', wake); window.addEventListener('focus', wake); window.addEventListener('pageshow', wake); window.addEventListener('online', wake); window.addEventListener('offline', disconnected);
    return () => { disposed = true; mounted.current = false; cancelResume(); clearTimeout(timer); clearInterval(clock); readController.current?.abort(); writeController.current?.abort(); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); window.removeEventListener('pageshow', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', disconnected); };
  }, [load]);
  useEffect(() => { if (review) reviewRef.current?.querySelector<HTMLElement>('.execution-review')?.focus(); }, [review?.preview.id]);
  useEffect(() => { if (trackedJob && focusTracking.current) { focusTracking.current = false; trackingRef.current?.focus(); } }, [trackedJob]);

  async function mutate<T>(suffix: string, body: object, method: 'POST' | 'PUT' | 'DELETE' = 'POST'): Promise<MutationResult<T>> {
    if (busyRef.current || !navigator.onLine || !mounted.current || expiredSession) return { ok: false };
    busyRef.current = true; setBusy(true); setWriteError(''); setNotice(''); responseVersion.current++;
    readController.current?.abort();
    const controller = new AbortController(); writeController.current = controller;
    try {
      const value = await api<T>(BASE + suffix, { method, body: JSON.stringify(body), signal: controller.signal, timeoutMs: suffix.startsWith('/accounts/') ? 45_000 : 30_000 });
      if (!mounted.current || controller.signal.aborted) return { ok: false };
      return { ok: true, value };
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) { if (error instanceof ApiError && error.status === 401) expire(); else setWriteError(error instanceof Error ? error.message : '操作尚未确认，请核对执行状态'); }
      return { ok: false, error };
    } finally { if (writeController.current === controller) writeController.current = null; busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  const write: Write = async (suffix, body, method) => {
    const result = await mutate<ExecutionState>(suffix, body, method);
    if (!result.ok) return false;
    acceptState(result.value); setReview(current => current?.uncertain ? current : null);
    setNotice(suffix.endsWith('/stop') ? '已请求停止，正在核对并撤销余单。已成交仓位保留。' : suffix.endsWith('/reconcile') ? '核对请求已完成，请查看各腿最新状态。' : '实盘连接已更新。');
    return true;
  };
  function resetDraft() { setValues({}); setEqualSize(''); setReview(null); setWriteError(''); }
  function changeStructure(patch: Partial<ExecutionPreferences>) { updatePreferences({ ...patch, orientation: '' }); resetDraft(); }
  async function preview(body: ExecutionPlanInput | { resumeJobId: string }) {
    const requestedPair = pairRef.current;
    const requestedVersion = pairVersion.current;
    const result = await mutate<ExecutionPreview>('/preview', body);
    if (result.ok && requestedPair === pairRef.current && requestedVersion === pairVersion.current) setReview({ preview: result.value, requestId: crypto.randomUUID(), uncertain: false, pair: requestedPair });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!orientation) return;
    const equal = sizeMode === 'equal';
    // An empty chase limit means no limit; market legs never send one.
    const legs = draftLegs.map(leg => {
      const value = values[legKey(leg)], orderType = orderTypes[legKey(leg)] ?? 'chase', stopPrice = orderType === 'chase' ? value?.stopPrice.trim() ?? '' : '';
      return { ...leg, orderType, ...(equal ? {} : { quantity: value?.quantity.trim() || '' }), ...(stopPrice ? { stopPrice } : {}) };
    });
    if (equal && !positive(equalSize.trim()) || !equal && legs.some(leg => !positive(leg.quantity ?? ''))) { setWriteError(equal ? `请填写大于零的每腿${market === 'oil' ? '桶数' : market === 'anthropic' ? '股数' : '名义金额'}。` : '每腿数量须填写大于零的十进制数。'); return; }
    const sharesError = market === 'anthropic' ? sharesProblem(shares) : null;
    if (sharesError) { setWriteError(sharesError); return; }
    if (legs.some(leg => leg.stopPrice !== undefined && !positive(leg.stopPrice))) { setWriteError('追价界限须为大于零的十进制数，或留空表示不设界限。'); return; }
    await preview({ market, preset: activePreset, action, legs, ...(equal ? { equalSize: equalSize.trim() } : {}), ...(market === 'anthropic' ? { shares: { outstanding: shares.outstanding.trim(), diluted: shares.diluted.trim() } } : {}), batchCount: Number(batchCount), batchIntervalMs: Math.round(Number(batchInterval) * 1000), repriceIntervalMs: Math.round(Number(repriceInterval) * 1000), timeoutMs: Math.round(Number(timeout) * 1000) });
  }
  async function confirm() {
    if (!review || review.pair !== pairRef.current || busyRef.current || !navigator.onLine) return;
    const current = review;
    const requestedVersion = pairVersion.current;
    setReview({ ...current, uncertain: true });
    const result = await mutate<ExecutionSubmission>('/jobs', { previewId: current.preview.id, requestId: current.requestId, confirmLive: true });
    if (result.ok) {
      acceptState(result.value); setReview(null);
      if (result.value.acceptedJob) { focusTracking.current = true; setTrackedJob(result.value.acceptedJob); }
      else setNotice('组合已受理，但未返回本次执行编号，请在执行进度核对。');
    }
    // The server resolves a persisted request ID before checking preview expiry.
    // A definite rejection therefore lets this same submission return to editing.
    else if (result.error instanceof ApiError && [400, 403, 404, 409, 422].includes(result.error.status) && mounted.current && current.pair === pairRef.current && requestedVersion === pairVersion.current) setReview({ ...current, uncertain: false });
  }

  const anthropic = market === 'anthropic', activePreset = anthropic ? anthropicPreset(anthropicKeys) : preset;
  const legsFor = (reverse: boolean) => structure(market, activePreset, selectedExchange, selectedSymbol, reverse, pair, anthropicKeys);
  const draftLegs = legsFor(orientation === 'reverse');
  const fixed = anthropic ? null : MARKETS[market], sizing = fixed ?? ANTHROPIC_SIZING;
  const [labelA, labelB] = fixed?.labels ?? ['', ''], marketSymbols = fixed?.symbols ?? [];
  const sharesError = anthropic ? sharesProblem(shares) : null;
  const requiredExchanges = new Set(draftLegs.map(leg => leg.exchange));
  const missingConnection = !state || [...requiredExchanges].some(exchange => !state.connections.some(connection => connection.exchange === exchange && connection.connected));
  const elapsed = lastSuccess.current === null ? Infinity : performance.now() - lastSuccess.current;
  const stale = !!state && elapsed > 15_000;
  const serverNow = state ? Date.parse(state.generatedAt) + elapsed : Date.now();
  const reviewExpired = !!review && serverNow >= Date.parse(review.preview.expiresAt);
  const disabled = busy || offline;
  const activeJobs = state?.jobs.filter(job => !terminal(job) && job.id !== trackedJob?.id) ?? [], pastJobs = state?.jobs.filter(job => terminal(job) && job.id !== trackedJob?.id) ?? [];
  const trackingMissing = !!trackedJob && !terminal(trackedJob) && !state?.jobs.some(job => job.id === trackedJob.id);
  const trackingStale = offline || stale || !!readError || trackingMissing;
  const [leftName, rightName] = pairExchanges(pair).map(exchange => EXCHANGES[exchange]);
  if (expiredSession) return <section className="trading-panel execution-panel"><p className="execution-session-expired">登录已过期，请重新登录后核对执行状态。</p></section>;
  return <section className="trading-panel execution-panel" aria-labelledby="execution-title">
    <header className="trading-panel-heading"><div><h2 id="execution-title">组合交易</h2><p>Bybit 原生追逐限价单 · Binance / OKX 原订单追价 · Hyperliquid / Lighter RH 只挂单撤改 · 可选市价 · 分批开平仓</p></div><button className="button secondary" type="button" disabled={disabled || reading} onClick={() => void load(true)}><RefreshCw size={15} className={reading ? 'spin' : ''} />刷新执行状态</button></header>
    <div className={`execution-sync${offline || stale || readError ? ' stale' : ''}`} role="status"><Clock3 size={14} /><span>{offline ? '网络已断开，显示最后取得的执行状态。' : readError ? '执行状态读取失败，当前保留上次结果。' : stale ? '执行状态已过期，正在重新核对。' : state ? '前台每 3 秒更新执行状态。' : '正在读取执行状态…'}{state ? ` 最近取得：${date(state.generatedAt)}（北京时间）` : ''}</span></div>
    {readError ? <p className="execution-message warning" role="alert">{readError}</p> : null}
    {writeError ? <p className="execution-message warning" role="alert"><CircleAlert size={16} />{writeError}</p> : null}
    {notice ? <p className="execution-message" role="status">{notice}</p> : null}
    {trackedJob ? <section ref={trackingRef} tabIndex={-1} className="execution-jobs execution-tracking" aria-label="组合成交跟踪">
      <h3>成交进度与结果</h3>
      <p className={`execution-tracking-status${trackingStale || ['paused', 'attention', 'stopping'].includes(trackedJob.status) ? ' warning' : ''}`} role="status">{trackingStale ? '进度暂未更新，以下保留上次确认的结果；恢复后继续核对。' : TRACKING_STATUS[trackedJob.status]}</p>
      <p className="execution-tracking-id">执行编号：{trackedJob.id}{trackingMissing ? ' · 本轮未返回此任务，尚不能确认完成' : ''}</p>
      <JobCard key={trackedJob.id} job={trackedJob} disabled={disabled || trackingMissing} canPreview={!review && !trackingStale} write={write} resume={id => void preview({ resumeJobId: id })} />
    </section> : null}
    {activeJobs.length ? <div className="execution-jobs" aria-label="当前执行"><h3>执行进度</h3>{activeJobs.map(job => <JobCard key={job.id} job={job} disabled={disabled} canPreview={!review} write={write} resume={id => void preview({ resumeJobId: id })} />)}</div> : null}
    <div ref={reviewRef}>{review ? <Preview preview={review.preview} expired={reviewExpired} disabled={disabled} uncertain={review.uncertain} onSubmit={() => void confirm()} onEdit={() => { setReview(null); setWriteError(''); }} /> : null}</div>
    <form className="execution-builder" onSubmit={submit} aria-label="组合交易参数">
      <fieldset disabled={disabled || !!review}>
        <legend className="visually-hidden">选择组合并填写交易参数</legend>
        <div className="execution-row">
          <Choice label="品种" value={market} options={(Object.keys(MARKET_NAMES) as ExecutionMarket[]).map(value => [value, MARKET_NAMES[value]])} onChange={next => { setPreferences(current => { const profile = current.profiles[next]; return { ...current, market: next, profiles: { ...current.profiles, [next]: { ...profile, ...(next !== 'anthropic' && profile.preset !== 'same-exchange' && profile.pair !== pair ? { orientation: '' as const } : {}), pair } } }; }); resetDraft(); }} />
          <Choice label="交易动作" value={action} options={[['open', '开仓'], ['close', '平仓']]} onChange={next => changeStructure({ action: next })} />
          {anthropic ? null : preset === 'same-exchange' ? <Choice label="交易所" value={selectedExchange} options={PAIR_VENUES.map(value => [value, EXCHANGES[value]])} onChange={next => changeStructure({ selectedExchange: next })} />
            : preset === 'cross-exchange' ? <Choice label="合约" value={selectedSymbol} options={marketSymbols.map(symbol => [symbol, symbol])} onChange={next => changeStructure({ selectedSymbol: next })} /> : null}
          {!anthropic && preset !== 'same-exchange' ? <label>跨所组合<select aria-label="跨所组合" value={pair} onChange={event => onPair(event.target.value as TradingPair)}>{TRADING_PAIRS.map(value => <option key={value} value={value}>{pairExchanges(value).map(exchange => EXCHANGES[exchange]).join(' + ')}</option>)}</select></label> : null}
        </div>
        {anthropic ? <div className="execution-anthropic" role="group" aria-label="Anthropic 组合合约">
          {([0, 1] as const).map(index => <label key={index}>{index === 0 ? '合约 A' : '合约 B'}<select value={anthropicKeys[index]} onChange={event => { const next: [string, string] = [...anthropicKeys]; next[index] = event.target.value; changeStructure({ anthropicKeys: next }); }}>{ANTHROPIC_CONTRACTS.map(contract => { const key = contractKey(contract); return <option key={key} value={key} disabled={key === anthropicKeys[1 - index]}>{contract.label}</option>; })}</select></label>)}
          <label>流通股 · 十亿股<input type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={shares.outstanding} onChange={event => onShares({ ...shares, outstanding: event.target.value })} /></label>
          <label>完全稀释股 · 十亿股<input type="text" inputMode="decimal" autoComplete="off" maxLength={24} value={shares.diluted} onChange={event => onShares({ ...shares, diluted: event.target.value })} /></label>
          {sharesError ? <p className="execution-warning" role="alert">{sharesError}</p> : <p className="execution-help">{PRESETS[activePreset]} · 两腿按估算股数配平，股数假设与实时价差表共用，预览时固定。只在两侧最终按相同每股价格结算时收敛，不是保证收益；Hyperliquid 与 Lighter RH 按账户当前杠杆与保证金模式成交，本系统不修改。</p>}
        </div>
          : <div className="execution-presets" role="group" aria-label="交易预设">{(Object.keys(PRESETS) as ExecutionPreset[]).map(value => <button key={value} type="button" aria-pressed={preset === value} onClick={() => { changeStructure({ preset: value }); }}>{PRESETS[value]}<small>{value === 'four-leg' ? `${leftName} 与 ${rightName} · ${labelA} 对 ${labelB}` : value === 'same-exchange' ? `单所 · ${labelA} 对 ${labelB}` : `${leftName} 对 ${rightName} · 同一合约`}</small></button>)}</div>}
        <div className="execution-choice execution-direction"><span aria-hidden="true">{action === 'open' ? '开仓方向' : '待平仓方向'}</span><div className="execution-direction-options" role="group" aria-label={action === 'open' ? '开仓方向' : '待平仓方向'}>{(['forward', 'reverse'] as const).map(value => <button key={value} type="button" aria-pressed={orientation === value} onClick={() => { updatePreferences({ orientation: value }); setValues({}); }}>{legsFor(value === 'reverse').map(leg => <span key={legKey(leg)} className={`execution-leg-chip ${leg.side}`}>{EXCHANGES[leg.exchange]} {anthropic ? leg.symbol : leg.symbol === marketSymbols[0] ? labelA : labelB} <b>{leg.side === 'long' ? '多' : '空'}</b></span>)}</button>)}</div></div>
        <div className="execution-row execution-sizing">
          <Choice label="数量方式" value={sizeMode} options={[['equal', sizing.sizing], ['per-leg', '逐腿填写']]} onChange={next => { updatePreferences({ sizeMode: next }); setEqualSize(''); setValues({}); }} />
          {sizeMode === 'equal' ? <label className="execution-amount">{market === 'oil' ? '每腿桶数' : anthropic ? '每腿股数' : '每腿名义金额'}<span className="execution-input-unit"><input type="text" inputMode="decimal" autoComplete="off" value={equalSize} required maxLength={48} pattern="[0-9]+([.][0-9]{1,18})?" placeholder={market === 'hynix' ? '例如 1000' : '例如 100'} onChange={event => setEqualSize(event.target.value)} /><span aria-hidden="true">{sizing.unit}</span></span></label> : null}
          <p className="execution-help">{sizeMode === 'equal' ? `${sizing.hint}实际各腿数量以预览为准。` : 'OKX 按张填写，其他交易所按原生合约单位；开仓时多空两侧须大致平衡。'}</p>
        </div>
        {orientation ? <div className={`execution-leg-inputs${sizeMode === 'per-leg' ? ' per-leg' : ''}`}>{draftLegs.map(leg => {
          const key = legKey(leg), value = { quantity: values[key]?.quantity ?? '', stopPrice: values[key]?.stopPrice ?? '', orderType: orderTypes[key] ?? 'chase' as const }, buy = orderSide(action, leg.side) === 'buy';
          const position = state?.positions.find(row => row.exchange === leg.exchange && row.symbol === leg.symbol && row.side === leg.side);
          return <section key={key} className="execution-leg-input" aria-label={`${EXCHANGES[leg.exchange]} ${leg.symbol} 交易参数`}><header><strong>{EXCHANGES[leg.exchange]} {leg.symbol}</strong><span className={`execution-side ${leg.side}`}>{operation(action, leg.side)}</span></header>{sizeMode === 'per-leg' ? <div><label>数量 · {quantityUnit(leg.exchange)}<input type="text" inputMode="decimal" autoComplete="off" value={value.quantity} required maxLength={80} pattern="[0-9]+([.][0-9]{1,18})?" onChange={event => setValues(current => ({ ...current, [key]: { ...value, quantity: event.target.value } }))} /></label>{action === 'close' ? <div className="execution-position-hint"><span>{position ? `最近${direction(leg.side)} ${amount(position.quantity)} · ${date(position.fetchedAt)}` : `尚无该方向仓位数据`}</span><button type="button" className="text-button" disabled={!position || !positive(position.quantity)} onClick={() => position && setValues(current => ({ ...current, [key]: { ...value, quantity: position.quantity } }))}>填入当前数量</button></div> : null}</div> : null}<Choice label="下单方式" value={value.orderType} options={ORDER_TYPES} onChange={next => updatePreferences({ orderTypes: { ...orderTypes, [key]: next } })} />{value.orderType === 'market' ? <p className="execution-help execution-market-note">按对手盘吃单成交，不设价格界限，成交价可能偏离盘口。</p> : <label>{buy ? '追价上限' : '追价下限'} · {quoteAsset(leg.exchange)}（选填）<input type="text" inputMode="decimal" autoComplete="off" value={value.stopPrice} maxLength={80} pattern="[0-9]+([.][0-9]{1,18})?" placeholder={`留空不设${buy ? '上限' : '下限'}`} onChange={event => setValues(current => ({ ...current, [key]: { ...value, stopPrice: event.target.value } }))} /></label>}</section>;
        })}</div> : <p className="execution-choose-direction">先选择方向，再设置各腿下单方式。</p>}
        <details className="execution-advanced" open={advanced} onToggle={event => { const open = event.currentTarget.open; if (open !== advanced) updatePreferences({ advanced: open }); }}><summary><span><strong>执行参数</strong><small>{batchCount || '?'} 批 · 批间 {batchInterval || '?'} 秒 · 追价间隔 {repriceInterval || '?'} 秒 · 最长 {timeout || '?'} 秒</small></span><ChevronDown size={16} /></summary>
          <div className="execution-settings"><label>拆分批数<input type="number" min="1" max="200" step="1" required value={batchCount} onChange={event => updatePreferences({ batchCount: event.target.value })} /></label><label>批间等待 · 秒<input type="number" min="0" max="600" step="0.001" required value={batchInterval} onChange={event => updatePreferences({ batchInterval: event.target.value })} /></label><label>本地追价间隔（Binance / OKX / Hyperliquid / Lighter RH） · 秒<input type="number" min="1" max="60" step="0.001" required value={repriceInterval} onChange={event => updatePreferences({ repriceInterval: event.target.value })} /></label><label>最长执行 · 秒<input type="number" min="30" max="3600" step="0.001" required value={timeout} onChange={event => updatePreferences({ timeout: event.target.value })} /></label></div>
          <p className="execution-help">每批各腿完成后才进入下一批。达到追价界限、最长时间或出现无法核对的状态时，停止后续批次并处理余单；已成交数量单独保留。</p>
        </details>
        <div className="execution-builder-footer"><p>{missingConnection ? '此组合需要的实盘账户尚未全部连接。' : '预览会重新读取交易账户的盘口、规则与持仓，不会下单。'}</p>{missingConnection && state ? <button className="button secondary" type="button" onClick={() => { const element = connectionsRef.current; if (element) { element.open = true; element.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }}><Link2 size={16} />连接实盘账户</button> : null}<button className="button primary" type="submit" disabled={missingConnection || !orientation || stale || !!sharesError}><ArrowRightLeft size={16} />预览{action === 'open' ? '开仓' : '平仓'}组合</button></div>
      </fieldset>
    </form>
    <details ref={connectionsRef} className="execution-connections"><summary><span><Link2 size={17} /><strong>实盘账户连接</strong><small>{state?.connections.filter(connection => connection.connected).length ?? 0} / {state?.connections.length ?? 5} 已连接</small></span><ChevronDown size={17} /></summary><div><p className="execution-help">这里的交易密钥独立保存，不覆盖「账户连接」标签中用于仓位观察与资金费统计的只读账户。执行进度按本区账户显示，UID 与只读账户不同时，两区数据不能合并理解。密钥不保存在浏览器，保存后不回显。</p>{state ? <div className="execution-connection-grid">{state.connections.map(connection => connection.exchange === 'hyperliquid' ? <WalletConnectionForm key={`${connection.exchange}:${connection.revision}`} connection={connection} disabled={disabled || !!review} write={write} /> : connection.exchange === 'rh-lighter' ? <LighterConnectionForm key={`${connection.exchange}:${connection.revision}`} connection={connection} disabled={disabled || !!review} write={write} /> : <ConnectionForm key={`${connection.exchange}:${connection.revision}`} connection={connection} disabled={disabled || !!review} write={write} />)}</div> : <button className="button secondary" type="button" disabled={disabled || reading} onClick={() => void load(true)}>重新读取连接状态</button>}</div></details>
    {pastJobs.length ? <details className="execution-history"><summary>已完成与已停止的执行（{pastJobs.length}）</summary><div>{pastJobs.map(job => <JobCard key={job.id} job={job} disabled={disabled} canPreview={!review} write={write} resume={id => void preview({ resumeJobId: id })} />)}</div></details> : null}
  </section>;
}
