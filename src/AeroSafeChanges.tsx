import { useEffect, useState } from 'react';
import { Download, ListChecks, LoaderCircle, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import type { AeroSafe } from './aero-safe-client';
import { exactUnits, rawUnits, same, units } from './aero-safe-client';
import type { AeroSafeAllowanceEffect, AeroSafeBatchItems, AeroSafeChangeBatch } from './aero-safe-types';

type Row = { token: string; symbol: string; decimals: number | null; current: string | null; pending: string | null; remaining: string | null };
// 每行输入：value 为输入框内容，base 为上次与服务端同步时的显示值（value 与之不同即未提交的改动），decimals 为同步时的精度；
// recheck：未提交的改动期间精度变了（含读不到 / 重新读到），须提示核对。
type Draft = { value: string; base: string; decimals: number | null; recheck: boolean };
const itemsText = (items: AeroSafeBatchItems) => [items.pools.length ? `加池 ${items.pools.join('、')}` : '', items.allowances.length ? `额度 ${items.allowances.map((a) => `${a.symbol} ${exactUnits(a.perDay, a.decimals)}`).join('、')}` : ''].filter(Boolean).join('；');
const hasItems = (items: AeroSafeBatchItems | undefined) => Boolean(items && (items.pools.length || items.allowances.length));
const effectAmount = (a: AeroSafeAllowanceEffect, raw: string) => (a.decimals === null ? `${raw}（最小单位）` : `${exactUnits(raw, a.decimals)} ${a.symbol}`);
const effectText = (a: AeroSafeAllowanceEffect) => (a.first ? `${a.symbol}：链上尚无此额度，首次设置为每日 ${effectAmount(a, a.perDay)}，执行后本期可用 ${effectAmount(a, a.perDay)}`
  : `${a.symbol}：每日 ${a.previous === null ? '' : `${effectAmount(a, a.previous)} → `}${effectAmount(a, a.perDay)}；本期已用 ${effectAmount(a, a.used)}，执行后本期剩余 ${effectAmount(a, a.balance)}，不在本期重新计满${a.nextRefill === null ? '' : `，${new Date(a.nextRefill * 1000).toLocaleString('zh-CN')} 起按新额度补满`}`);

// 白名单变更：调整每日额度、查看待加池，合成一份增量 Safe 批次；硬件钱包在 Safe{Wallet} 执行后核对生效并并入配置。
export function AeroSafeChanges({ safe }: { safe: AeroSafe }) {
  const { state, busy, call, buildBatch } = safe;
  const changes = state?.changes;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
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
  // 服务端状态变化后逐行同步：没改过的行回到最新值（含刚保存的调整）；改过未提交的行保留输入，精度变了标出来重新核对。
  useEffect(() => {
    setDrafts((prev) => Object.fromEntries(rows.map((r) => {
      const base = shown(r), old = prev[r.token];
      // 按最小单位判断已收敛：输入 750.120 提交后服务端显示 750.12，同一数量不能一直算作未提交。
      const converged = old && r.decimals !== null && rawUnits(old.value, r.decimals) === (r.pending ?? r.current);
      if (!old || old.value === old.base || old.value === base || converged) return [r.token, { value: base, base, decimals: r.decimals, recheck: false }];
      return [r.token, { value: old.value, base, decimals: r.decimals, recheck: old.recheck || old.decimals !== r.decimals }];
    })));
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const valueOf = (r: Row) => drafts[r.token]?.value ?? shown(r);
  const edit = (r: Row, value: string) => setDrafts((prev) => ({ ...prev, [r.token]: { value, base: prev[r.token]?.base ?? shown(r), decimals: r.decimals, recheck: false } }));
  const resetInputs = () => setDrafts(Object.fromEntries(rows.map((r) => [r.token, { value: shown(r), base: shown(r), decimals: r.decimals, recheck: false }])));
  const edits = rows.filter((r) => r.decimals !== null && valueOf(r) !== shown(r));
  const held = rows.filter((r) => r.decimals === null && valueOf(r) !== shown(r));
  const invalid = edits.find((r) => rawUnits(valueOf(r), r.decimals!) === null);
  const saveAllowances = () => {
    if (!edits.length || invalid) return;
    void call('allowances', '/changes/allowances', 'POST', { allowances: Object.fromEntries(edits.map((r) => [r.token, valueOf(r).trim()])) });
  };
  const batch = changes?.batch ?? null;
  const pendingCount = (changes?.pools.length ?? 0) + (changes?.allowances.length ?? 0);
  const generate = async () => {
    if (batch && !window.confirm(batch.stale ? '已有一份批次因 Safe 配置变化而失效。新批次按链上当前额度折算；旧批次文件不要再执行，否则会把相关代币本期可用额度重新放开。\n\n仍要重新生成？'
      : '已有一份未核对启用的批次。它如已在 Safe 执行，请先点「已执行，核对并启用」。新批次按链上当前额度折算；旧批次文件不要再执行，否则会把相关代币本期可用额度重新放开。\n\n仍要重新生成？')) return;
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
      <p className="as-muted">每日额度是 bot 每 24 小时最多能投入开仓或兑换卖出的数量，bot 私钥泄露时每个代币每天的损失也以此为上限。改动先记为待变更，与待加池合成一份 Safe 批次，由硬件钱包执行后生效。生成批次时读取链上本期已用，执行后本期累计不超过新额度，下一个补充时刻起按新额度补满。</p>
      <div className="lp-table-scroll"><table className="lp-table as-table"><thead><tr><th>代币</th><th className="num">当前每日额度</th><th className="num">今日剩余</th><th className="num">新额度（代币数量）</th></tr></thead><tbody>
        {rows.map((r) => <tr key={r.token}>
          <td>{r.symbol}{r.current === null ? <small className="as-muted"> 新代币</small> : null}</td>
          <td className="num">{r.current === null ? '—' : amountOf(r.current, r.decimals, r.symbol)}</td>
          <td className="num">{amountOf(r.remaining, r.decimals, r.symbol)}</td>
          <td className="num"><input aria-label={`${r.symbol} 新每日额度`} inputMode="decimal" value={valueOf(r)} disabled={r.decimals === null || !!busy || running}
            title={r.decimals === null ? '代币精度尚未读取，请先刷新链上状态' : undefined} onChange={(e) => edit(r, e.target.value.trim())} />
            {r.pending !== null && r.current !== null ? <small className="as-muted"> 待改，原 {r.decimals === null ? '—' : exactUnits(r.current, r.decimals)}</small> : null}
            {drafts[r.token]?.recheck && valueOf(r) !== shown(r) ? <small className="as-warn" role="status">{r.decimals === null ? '代币精度暂时读不到，已保留未提交的输入；读到后请核对' : `代币精度已变化（现为 ${r.decimals} 位），已保留未提交的输入，请核对`}{r.decimals !== null && rawUnits(valueOf(r), r.decimals) === null ? `：最多 ${r.decimals} 位小数` : ''}</small> : null}</td>
        </tr>)}
      </tbody></table></div>
      <div className="as-form">
        <button type="button" className="button secondary" disabled={!!busy || running || !edits.length || !!invalid} title={invalid ? `${invalid.symbol} 额度须为正数，最多 ${invalid.decimals} 位小数` : undefined} onClick={saveAllowances}>{busy === 'allowances' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}记为待改额度</button>
        {edits.length || held.length ? <button type="button" className="button secondary" disabled={!!busy} onClick={resetInputs}>还原输入</button> : null}
        <span className="as-muted">改回当前值即撤回该项调整。</span>
      </div>

      <h3>待加池</h3>
      {changes.pools.length ? <ul className="as-list">{changes.pools.map((p) => <li key={p.address}>
        <strong>{p.name}</strong> <small className="as-muted">{p.address}</small>
        {p.gaugeStatus?.state !== 'alive' ? <small className="as-warn" role="status">gauge 状态未知：{p.gaugeStatus?.note ?? '加入时未核对 gauge 是否已被停用'}</small> : null}
        <button type="button" className="as-link" disabled={!!busy || running} aria-label={`移出 ${p.name}`} onClick={() => void call('unqueue', '/changes/remove', 'POST', { pool: p.address })}><X size={13} />移出</button>
      </li>)}</ul> : <p className="as-muted">没有待加池。在 Aero「市场」打开池子详情，不在白名单的池子可以加入待加池，多个池子可同时等待。</p>}

      {changes.persistError ? <div className="lp-callout warning" role="alert">{changes.persistError}</div> : null}
      {changes.preview.error ? <div className="lp-callout warning" role="alert">{changes.preview.error}</div>
        : changes.preview.transactions ? <p className="as-muted">合成的批次共 {changes.preview.transactions} 笔{changes.preview.usage.length ? `，条件树最多用到 ${Math.max(...changes.preview.usage.map((u) => u.nodes))}/255 个节点` : ''}。</p> : null}
      <div className="as-form">
        <button type="button" className="button secondary" disabled={!!busy || running || !changes.preview.transactions || !!changes.preview.error} onClick={() => void generate()}>{busy === 'batch' ? <LoaderCircle size={15} className="spin" /> : <ListChecks size={15} />}生成 Safe 批次</button>
        {fresh ? <button type="button" className="button secondary" onClick={download}><Download size={15} />下载批次 JSON</button> : null}
      </div>
      {fresh ? <>
        <p className="as-muted">批次共 {fresh.transactions.length} 笔{usage !== null ? `，条件树最多用到 ${usage}/255 个节点` : ''}。下载后在 Safe{'{'}Wallet{'}'} →「应用」→ Transaction Builder 拖入 JSON（提示无法校验 checksum 属正常），逐笔核对后用硬件钱包签名执行；同一批次只执行一次。</p>
        {fresh.allowances?.length ? <div className="lp-callout warning" role="status">
          <p>执行该批次后的每日额度（按 {new Date(fresh.allowances[0].readAt * 1000).toLocaleString('zh-CN')} 的链上读数）：</p>
          <ul>{fresh.allowances.map((a) => <li key={a.key}>{effectText(a)}</li>)}</ul>
          <p>链上无法阻止重复执行：同一批次再执行一次，或生成后到执行前 bot 又有开仓兑换，本期累计会超过新额度。{fresh.allowances.map((a) => `${a.symbol} 每多执行一次本期最多再花 ${effectAmount(a, a.replay.samePeriod)}，到之后的周期再执行则当期重新计满 ${effectAmount(a, a.replay.laterPeriod)}`).join('；')}。请只执行一次；生成后到执行前不想多花，可先关闭自动调仓。</p>
        </div> : null}
        <details className="as-muted"><summary>批次明细</summary><ol>{fresh.transactions.map((t, i) => <li key={i}>{t.description}</li>)}</ol></details>
      </> : null}
      {batch ? <>
        <p className="as-muted">{new Date(batch.createdAt).toLocaleString('zh-CN')} 生成的批次（{batch.transactions} 笔）：{[batch.pools.length ? `加池 ${batch.pools.join('、')}` : '', batch.allowances.length ? `额度 ${batch.allowances.map((a) => `${a.symbol} ${exactUnits(a.perDay, a.decimals)}`).join('、')}` : ''].filter(Boolean).join('；')}。{fresh ? '' : '如需重新下载，请再点一次「生成 Safe 批次」。'}</p>
        {batch.stale ? <div className="lp-callout warning" role="status">{batch.staleReason ?? 'Safe 配置在生成批次后已变化，这份批次不能再核对，请重新生成'}。</div> : <>
          {hasItems(batch.withdrawn) ? <div className="lp-callout warning" role="status">生成批次之后已从草稿撤回或改了值：{itemsText(batch.withdrawn)}。已生成的批次文件仍包含这些操作，在 Safe 执行仍会生效，核对启用后也会并入配置；不想执行它们，请重新生成批次并只执行新文件。</div> : null}
          {hasItems(batch.added) ? <p className="as-muted">生成批次之后新增，未包含在这份批次里：{itemsText(batch.added)}。核对启用后它们继续保留，可再生成下一份批次。</p> : null}
          {batch.behind && !hasItems(batch.withdrawn) && !hasItems(batch.added) ? <p className="as-muted">最新草稿合成的权限与这份批次不同，请核对后再执行。</p> : null}
        </>}
        <div className="as-form">
          {!batch.stale ? <button type="button" className="button primary" disabled={!!busy || running || !state.wallet} title={!state.wallet ? '请先填写 bot 私钥' : undefined} onClick={() => void call('apply', '/changes/apply', 'POST', {}, 120_000)}>{busy === 'apply' ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}已执行，核对并启用</button> : null}
        </div>
      </> : null}
      {pendingCount || batch ? <div className="as-form"><button type="button" className="button secondary" disabled={!!busy} onClick={() => { if (window.confirm('放弃全部待变更与已生成的批次？已在 Safe 执行的批次不会因此撤回。')) { setBuilt(null); void call('clearChanges', '/changes/clear', 'POST', {}); } }}><Trash2 size={15} />全部放弃</button></div> : null}
    </div>
  </section>;
}
