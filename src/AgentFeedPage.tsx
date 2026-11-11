import { useState } from 'react';
import type { FormEvent } from 'react';
import { Copy, KeyRound, LoaderCircle, Trash2 } from 'lucide-react';
import { api, ApiError } from './api';
import './agent-feed.css';
import { Callout, StatePanel, TableEmpty } from './StateViews';
import { useLiveResource } from './use-live-resource';

type Scope = 'public' | 'system';
type Token = { id: string; label: string; scopes: Scope[]; createdAt: string; lastUsedAt: string | null };
type State = { schemaVersion: 1; tokens: Token[]; corrupt: boolean; maxTokens: number; scopes: Scope[]; requestsPerMinute: number; datasets: { id: string; scope: Scope; title: string }[] };
type Created = { token: string; entry: Token };

const scopeLabels: Record<Scope, string> = { public: '公开行情', system: '系统状态' };
const scopeHints: Record<Scope, string> = { public: 'Monitor 行情指标与 Aero 池子行情', system: '服务器负载、模块与数据来源的运行状态' };
const time = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const message = (reason: unknown) => reason instanceof Error ? reason.message : '请求失败，请重试。';

export default function AgentFeedPage({ onExpired }: { onExpired: () => void }) {
  // 打开时读取一次；创建、撤销确认后重读，之前发出的读取作废。
  const feed = useLiveResource<State>('/api/system/agent-feed', { intervalMs: null, timeoutMs: 15_000, onExpired });
  const state = feed.data;
  const [actionError, setActionError] = useState('');
  const error = actionError || (feed.error?.message ?? '');
  const [busy, setBusy] = useState('');
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['public', 'system']);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const fail = (reason: unknown) => { if (reason instanceof ApiError && reason.status === 401) onExpired(); else setActionError(message(reason)); };

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy('create'); setCopied(false);
    try {
      const result = await api<Created>('/api/system/agent-feed/tokens', { method: 'POST', body: JSON.stringify({ label: label.trim(), scopes }) });
      setCreated(result); setLabel(''); setActionError(''); await feed.refresh();
    } catch (reason) { fail(reason); } finally { setBusy(''); }
  }
  async function revoke(token: Token) {
    if (!window.confirm(`撤销令牌「${token.label}」？使用它的 agent 会立即失去访问。`)) return;
    setBusy(token.id);
    try { await api(`/api/system/agent-feed/tokens/${token.id}`, { method: 'DELETE' }); if (created?.entry.id === token.id) setCreated(null); setActionError(''); await feed.refresh(); }
    catch (reason) { fail(reason); } finally { setBusy(''); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); setActionError('浏览器不允许写入剪贴板，请手动选中复制。'); }
  }
  const toggle = (scope: Scope) => setScopes(current => current.includes(scope) ? current.filter(item => item !== scope) : [...current, scope]);
  const example = `curl -H "Authorization: Bearer ${created?.token ?? '<令牌>'}" ${location.origin}/api/agent/v1/catalog`;
  const full = !!state && state.tokens.length >= state.maxTokens;

  return <div className="wb-page">
    <header className="wb-heading"><div><h1>Agent 数据接口</h1><p>给其他 agent 的只读数据入口：用令牌读取数据目录和当前快照，不能登录页面、下单或修改任何设置</p></div></header>
    {error ? <Callout tone="warning">{error}</Callout> : null}
    {state?.corrupt ? <Callout tone="warning">已保存的令牌记录无法读取，原有令牌全部失效。新建令牌后恢复使用。</Callout> : null}
    {created ? <section className="panel wb-section af-created" aria-label="新令牌"><div className="panel-heading"><h2>令牌「{created.entry.label}」已创建</h2><span className="muted">只显示这一次</span></div>
      <div className="af-body"><p>请现在复制并保存；离开或刷新页面后无法再次查看，只能撤销重建。</p>
        <code className="af-token">{created.token}</code>
        <div className="wb-toolbar"><button className="button primary" onClick={() => void copy(created.token)}><Copy size={15} />{copied ? '已复制' : '复制令牌'}</button><button className="button secondary" onClick={() => setCreated(null)}>我已保存</button></div>
      </div></section> : null}
    {!state ? error ? null : <StatePanel kind="loading" title="正在读取令牌" /> : <>
      <section className="panel wb-section" aria-label="令牌"><div className="panel-heading"><h2>令牌 <span className="count-label">{state.tokens.length} / {state.maxTokens}</span></h2><span className="muted">每个令牌每分钟最多 {state.requestsPerMinute} 次请求</span></div>
        {state.tokens.length ? <div className="af-table"><table><thead><tr><th>名称</th><th>数据范围</th><th>创建于</th><th>最近使用</th><th /></tr></thead><tbody>
          {state.tokens.map(token => <tr key={token.id}><td>{token.label}</td><td>{token.scopes.map(scope => scopeLabels[scope]).join('、')}</td><td>{time.format(Date.parse(token.createdAt))}</td>
            <td>{token.lastUsedAt ? time.format(Date.parse(token.lastUsedAt)) : '重启后未使用'}</td>
            <td className="right"><button className="button secondary" disabled={!!busy} onClick={() => void revoke(token)}>{busy === token.id ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}撤销</button></td></tr>)}
        </tbody></table></div> : <TableEmpty>还没有令牌</TableEmpty>}
        <form className="wb-key af-form" onSubmit={event => void create(event)} autoComplete="off">
          <label className="wb-field wide"><span>新令牌名称</span><input value={label} maxLength={40} onChange={event => setLabel(event.target.value)} placeholder="例如：巡检 agent" /><small>用来区分是哪个 agent 在用，方便单独撤销。</small></label>
          <div className="af-scopes">{state.scopes.map(scope => <label key={scope} className="checkbox-field"><input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} /><span>{scopeLabels[scope]}<small>{scopeHints[scope]}</small></span></label>)}</div>
          <div className="wb-key-actions"><button className="button primary" type="submit" disabled={!!busy || !label.trim() || !scopes.length || full}>{busy === 'create' ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}生成令牌</button>{full ? <span className="muted">已达上限，请先撤销不用的令牌</span> : null}</div>
        </form>
      </section>
      <section className="panel wb-section" aria-label="使用方法"><div className="panel-heading"><h2>使用方法</h2></div>
        <div className="af-body"><p>在请求头带上令牌。先读 <code>/api/agent/v1/catalog</code> 了解有哪些数据集和字段，再读 <code>/api/agent/v1/snapshot?datasets=…</code> 取当前值。服务器上的 agent 用本机地址访问即可。</p>
          <code className="af-token">{example}</code>
          <p>快照每 5 秒更新一次，轮询更快不会拿到更新的数据。每行带采集时间 <code>asOf</code> 与是否过期 <code>stale</code>；读不到的值是 <code>null</code>，不是 0。持仓、盈亏、余额与任何凭据不在接口范围内。</p></div>
      </section>
      <section className="panel wb-section" aria-label="数据集"><div className="panel-heading"><h2>数据集 <span className="count-label">{state.datasets.length}</span></h2></div>
        <div className="af-table"><table><thead><tr><th>标识</th><th>内容</th><th>数据范围</th></tr></thead><tbody>
          {state.datasets.map(dataset => <tr key={dataset.id}><td><code>{dataset.id}</code></td><td>{dataset.title}</td><td>{scopeLabels[dataset.scope]}</td></tr>)}
        </tbody></table></div>
      </section>
    </>}
  </div>;
}
