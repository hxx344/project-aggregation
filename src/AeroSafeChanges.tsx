import { useEffect, useState } from 'react';
import { Download, ListChecks, LoaderCircle, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import type { AeroSafe } from './aero-safe-client';
import { exactUnits, rawUnits, same, units } from './aero-safe-client';
import type { AeroSafeChangeBatch } from './aero-safe-types';

type Row = { token: string; symbol: string; decimals: number | null; current: string | null; pending: string | null; remaining: string | null };

// 白名单变更：调整每日额度、查看待加池，合成一份增量 Safe 批次；硬件钱包在 Safe{Wallet} 执行后核对生效并并入配置。
export function AeroSafeChanges({ safe }: { safe: AeroSafe }) {
  const { state, busy, call, buildBatch } = safe;
  const changes = state?.changes;
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [built, setBuilt] = useState<AeroSafeChangeBatch | null>(null);
  const configured = state?.config?.permissions.allowances ?? [];
  const decimalsOf = (token: string) => state?.chain?.tokens.find((t) => same(t.address, token))?.decimals ?? null;
  const rows: Row[] = [
    ...configured.map((a) => ({ token: a.token, symbol: a.symbol, decimals: decimalsOf(a.token), current: a.perDay,
      pending: changes?.allowances.find((x) => same(x.token, a.token))?.perDay ?? null, remaining: state?.chain?.allowances.find((x) => same(x.token, a.token))?.remaining ?? null })),
    ...(changes?.allowances ?? []).filter((a) => a.current === null).map((a) => ({ token: a.token, symbol: a.symbol, decimals: a.decimals, current: null, pending: a.perDay, remaining: null })),
  ];
  const shown = (r: Row) => (r.decimals === null ? '' : exactUnits(r.pending ?? r.current ?? '0', r.decimals));
  const signature = rows.map((r) => `${r.token}:${r.pending ?? r.current}:${r.decimals}`).join('|');
  // 服务端状态变化后输入框回到最新值（含刚保存的调整）。
  useEffect(() => { setInputs(Object.fromEntries(rows.map((r) => [r.token, shown(r)]))); }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const edits = rows.filter((r) => r.decimals !== null && (inputs[r.token] ?? '') !== shown(r));
  const invalid = edits.find((r) => rawUnits(inputs[r.token] ?? '', r.decimals!) === null);
  const saveAllowances = () => {
    if (!edits.length || invalid) return;
    void call('allowances', '/changes/allowances', 'POST', { allowances: Object.fromEntries(edits.map((r) => [r.token, inputs[r.token].trim()])) });
  };
  const batch = changes?.batch ?? null;
  const pendingCount = (changes?.pools.length ?? 0) + (changes?.allowances.length ?? 0);
  const generate = async () => {
    if (batch && !batch.stale && !window.confirm('已有一份未核对启用的批次。它如已在 Safe 执行，请先点「已执行，核对并启用」；新批次会重复其中的额度设置，再执行会把相关代币当天额度重置为满额。\n\n仍要重新生成？')) return;
    const data = await buildBatch();
    if (data) setBuilt(data);
  };
  const download = () => {
    if (!built) return;
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(built.builder, null, 2)}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `aero-roles-changes-${new Date(built.state.changes?.batch?.createdAt ?? Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const fresh = built && batch && built.state.changes?.batch?.createdAt === batch.createdAt ? built : null;
  const usage = fresh?.usage.length ? Math.max(...fresh.usage.map((u) => u.nodes)) : null;
  const running = state?.job?.status === 'running';
  if (!state?.configured || !changes) return null;
  const amountOf = (raw: string | null, decimals: number | null, symbol: string) => (raw === null || decimals === null ? '—' : `${units(raw, decimals)} ${symbol}`);
  return <section className="panel lp-section" aria-label="白名单变更">
    <div className="panel-heading"><h2>白名单变更</h2><span className="muted">{pendingCount ? `${changes.pools.length} 个待加池 · ${changes.allowances.length} 项额度待改` : '没有待变更'}</span></div>
    <div className="as-panel-body">
      <p className="as-muted">每日额度是 bot 每 24 小时最多能投入开仓或兑换卖出的数量，bot 私钥泄露时每个代币每天的损失也以此为上限。改动先记为待变更，与待加池合成一份 Safe 批次，由硬件钱包执行后生效；执行后当天可用额度按新值计满。</p>
      <div className="lp-table-scroll"><table className="lp-table as-table"><thead><tr><th>代币</th><th className="num">当前每日额度</th><th className="num">今日剩余</th><th className="num">新额度（代币数量）</th></tr></thead><tbody>
        {rows.map((r) => <tr key={r.token}>
          <td>{r.symbol}{r.current === null ? <small className="as-muted"> 新代币</small> : null}</td>
          <td className="num">{r.current === null ? '—' : amountOf(r.current, r.decimals, r.symbol)}</td>
          <td className="num">{amountOf(r.remaining, r.decimals, r.symbol)}</td>
          <td className="num"><input aria-label={`${r.symbol} 新每日额度`} inputMode="decimal" value={inputs[r.token] ?? ''} disabled={r.decimals === null || !!busy || running}
            title={r.decimals === null ? '代币精度尚未读取，请先刷新链上状态' : undefined} onChange={(e) => setInputs((prev) => ({ ...prev, [r.token]: e.target.value.trim() }))} />
            {r.pending !== null && r.current !== null ? <small className="as-muted"> 待改，原 {exactUnits(r.current, r.decimals ?? 0)}</small> : null}</td>
        </tr>)}
      </tbody></table></div>
      <div className="as-form">
        <button type="button" className="button secondary" disabled={!!busy || running || !edits.length || !!invalid} title={invalid ? `${invalid.symbol} 额度须为正数，最多 ${invalid.decimals} 位小数` : undefined} onClick={saveAllowances}>{busy === 'allowances' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}记为待改额度</button>
        {edits.length ? <button type="button" className="button secondary" disabled={!!busy} onClick={() => setInputs(Object.fromEntries(rows.map((r) => [r.token, shown(r)])))}>还原输入</button> : null}
        <span className="as-muted">改回当前值即撤回该项调整。</span>
      </div>

      <h3>待加池</h3>
      {changes.pools.length ? <ul className="as-list">{changes.pools.map((p) => <li key={p.address}>
        <strong>{p.name}</strong> <small className="as-muted">{p.address}</small>
        <button type="button" className="as-link" disabled={!!busy || running} aria-label={`移出 ${p.name}`} onClick={() => void call('unqueue', '/changes/remove', 'POST', { pool: p.address })}><X size={13} />移出</button>
      </li>)}</ul> : <p className="as-muted">没有待加池。在 Aero「市场」打开池子详情，不在白名单的池子可以加入待加池，多个池子可同时等待。</p>}

      {changes.preview.error ? <div className="lp-callout warning" role="alert">{changes.preview.error}</div>
        : changes.preview.transactions ? <p className="as-muted">合成的批次共 {changes.preview.transactions} 笔{changes.preview.usage.length ? `，条件树最多用到 ${Math.max(...changes.preview.usage.map((u) => u.nodes))}/255 个节点` : ''}。</p> : null}
      <div className="as-form">
        <button type="button" className="button secondary" disabled={!!busy || running || !changes.preview.transactions || !!changes.preview.error} onClick={() => void generate()}>{busy === 'batch' ? <LoaderCircle size={15} className="spin" /> : <ListChecks size={15} />}生成 Safe 批次</button>
        {fresh ? <button type="button" className="button secondary" onClick={download}><Download size={15} />下载批次 JSON</button> : null}
      </div>
      {fresh ? <>
        <p className="as-muted">批次共 {fresh.transactions.length} 笔{usage !== null ? `，条件树最多用到 ${usage}/255 个节点` : ''}。下载后在 Safe{'{'}Wallet{'}'} →「应用」→ Transaction Builder 拖入 JSON（提示无法校验 checksum 属正常），逐笔核对后用硬件钱包签名执行；同一批次只执行一次。</p>
        <details className="as-muted"><summary>批次明细</summary><ol>{fresh.transactions.map((t, i) => <li key={i}>{t.description}</li>)}</ol></details>
      </> : null}
      {batch ? <>
        <p className="as-muted">{new Date(batch.createdAt).toLocaleString('zh-CN')} 生成的批次（{batch.transactions} 笔）：{[batch.pools.length ? `加池 ${batch.pools.join('、')}` : '', batch.allowances.length ? `额度 ${batch.allowances.map((a) => `${a.symbol} ${exactUnits(a.perDay, a.decimals)}`).join('、')}` : ''].filter(Boolean).join('；')}。{fresh ? '' : '如需重新下载，请再点一次「生成 Safe 批次」。'}</p>
        {batch.stale ? <div className="lp-callout warning" role="status">Safe 配置在生成批次后已变化，这份批次不能再核对，请重新生成。</div>
          : batch.behind ? <p className="as-muted">生成批次之后又有变更，未包含在这份批次里：核对启用后它们继续保留，可再生成下一份批次。</p> : null}
        <div className="as-form">
          {!batch.stale ? <button type="button" className="button primary" disabled={!!busy || running || !state.wallet} title={!state.wallet ? '请先填写 bot 私钥' : undefined} onClick={() => void call('apply', '/changes/apply', 'POST', {}, 120_000)}>{busy === 'apply' ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}已执行，核对并启用</button> : null}
        </div>
      </> : null}
      {pendingCount || batch ? <div className="as-form"><button type="button" className="button secondary" disabled={!!busy} onClick={() => { if (window.confirm('放弃全部待变更与已生成的批次？已在 Safe 执行的批次不会因此撤回。')) { setBuilt(null); void call('clearChanges', '/changes/clear', 'POST', {}); } }}><Trash2 size={15} />全部放弃</button></div> : null}
    </div>
  </section>;
}
