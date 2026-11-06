import { useEffect, useState } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import type { AeroPoolState, AeroSafePool, AeroSafePosition, AeroSafeState } from './aero-safe-types';
import { POOL_STATE_TEXT, autoSellNote, policyRule, same, tokenOf, usd, type AeroSafe } from './aero-safe-client';

// 撤出后可换成的代币：本池两种代币里，白名单有「另一种 → 它」兑换路径的。
export function exitTokens(state: AeroSafeState, pool: AeroSafePool) {
  const swaps = state.config?.permissions.swaps ?? [];
  return [pool.token0, pool.token1].filter((out) => swaps.some((s) => same(s.tokenOut, out) && same(s.tokenIn, out === pool.token0 ? pool.token1 : pool.token0)));
}
const symbolOf = (state: AeroSafeState, address: string) => tokenOf(state.chain, address)?.symbol ?? address.slice(0, 8);
const exitNote = (state: AeroSafeState, pool: AeroSafePool, exitToken: string) => {
  if (!exitToken) return '';
  const other = same(exitToken, pool.token0) ? pool.token1 : pool.token0;
  return `\n\n撤出后把这次收回的 ${symbolOf(state, other)}${state.config?.autoSellRewards ? '（含卖 AERO 所得）' : ''} 换成 ${symbolOf(state, exitToken)}：不超过今日额度，价格冲击超过 1% 时不换；没换掉的留在 Safe，任务结果会写明。`;
};

// 本池的仓位策略：状态、美元上限、是否参与自动调仓。保存立即生效，不需要 Safe 签名。
export function PoolPolicy({ safe, pool, disabled, onStop }: { safe: AeroSafe; pool: AeroSafePool; disabled: boolean; onStop: () => void }) {
  const { state, busy, call, setActionError } = safe;
  const rule = policyRule(state, pool.address);
  const room = state?.policy?.rooms[pool.address.toLowerCase()];
  const saved = () => ({ state: rule.state, cap: rule.capUsd === null ? '' : String(rule.capUsd), auto: rule.auto });
  const [draft, setDraft] = useState(saved);
  const [dirty, setDirty] = useState(false);
  // 没有未保存的修改时跟随服务端；有修改时保留输入。
  useEffect(() => { if (!dirty) setDraft({ state: rule.state, cap: rule.capUsd === null ? '' : String(rule.capUsd), auto: rule.auto }); }, [dirty, rule.state, rule.capUsd, rule.auto]);
  const discard = () => { setDraft(saved()); setDirty(false); };
  const change = (patch: Partial<typeof draft>) => { setDraft({ ...draft, ...patch }); setDirty(true); };
  const corrupt = state?.policy?.corrupt ?? null;
  const save = async () => {
    const text = draft.cap.trim();
    const capUsd = text === '' ? null : Number(text);
    if (capUsd !== null && (!/^\d+(\.\d{1,2})?$/.test(text) || !(capUsd > 0))) { setActionError('本池上限须为正的美元金额（最多两位小数），留空即不限。'); return; }
    if (await call('policy', '/policy', 'PUT', { policy: { pool: pool.address, state: draft.state, capUsd, auto: draft.auto } })) setDirty(false);
  };
  const roomText = rule.capUsd === null ? '不限' : room?.error ? `上限 ${usd(rule.capUsd)}：${room.error}` : room?.inPoolUsd !== undefined ? `已用约 ${usd(room.inPoolUsd)} / ${usd(rule.capUsd)}，还能放约 ${usd(Math.max(0, room.roomUsd ?? 0))}` : `上限 ${usd(rule.capUsd)}`;
  return <div className="as-form as-policy" role="group" aria-label={`${pool.name} 仓位策略`}>
    <label>状态<select value={draft.state} disabled={!!corrupt} onChange={(e) => change({ state: e.target.value as AeroPoolState })}>
      {(Object.keys(POOL_STATE_TEXT) as AeroPoolState[]).map((s) => <option key={s} value={s}>{POOL_STATE_TEXT[s]}</option>)}
    </select></label>
    <label>本池上限（美元）<input inputMode="decimal" placeholder="不限" value={draft.cap} disabled={!!corrupt} onChange={(e) => change({ cap: e.target.value })} /></label>
    <label className="as-check"><input type="checkbox" checked={draft.auto} disabled={!!corrupt} onChange={(e) => change({ auto: e.target.checked })} />参与自动调仓</label>
    <button type="button" className="button secondary" disabled={!dirty || !!busy || !!corrupt} onClick={() => void save()}>{busy === 'policy' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存</button>
    {dirty ? <button type="button" className="as-link" onClick={discard}>放弃修改</button> : null}
    <span className="as-muted">{corrupt ?? `${POOL_STATE_TEXT[rule.state]} · ${roomText}${rule.auto ? '' : ' · 不自动调仓'}`}</span>
    {pool.positions.length ? <button type="button" className="button secondary" disabled={disabled} onClick={onStop}>停止本池…</button> : null}
  </div>;
}

// 停止本池：先把本池设为「已停止」（不再开仓、加仓与自动调仓），再可选地平掉本池全部头寸并换成一种币。
export function StopPool({ safe, pool, onClose, onStarted }: { safe: AeroSafe; pool: AeroSafePool; onClose: () => void; onStarted: (text: string) => void }) {
  const { state, busy, call, execute } = safe;
  const [exitAll, setExitAll] = useState(true);
  const [exitToken, setExitToken] = useState('');
  const [acceptPenalty, setAcceptPenalty] = useState(false);
  if (!state?.chain) return null;
  const chain = state.chain;
  const locked = pool.positions.filter((p) => p.staked && p.penaltyUntilBlock && Number(p.penaltyUntilBlock) > chain.blockNumber);
  const targets = exitTokens(state, pool);
  const rule = policyRule(state, pool.address);
  const submit = async () => {
    const lines = [`停止 ${pool.name}：设为「已停止」，不再开仓、加仓，自动调仓跳过本池。`];
    if (exitAll) lines.push(`然后平掉本池全部 ${pool.positions.length} 个头寸（解押、撤出流动性、销毁 NFT），代币回到 Safe。${locked.length ? acceptPenalty ? `\n${locked.length} 个头寸仍在罚没期内，会被罚没部分奖励。` : `\n${locked.length} 个头寸仍在罚没期内，未勾选接受罚没时不会平仓。` : ''}`);
    if (!window.confirm(`${lines.join('\n')}${exitAll ? `${exitNote(state, pool, exitToken)}${autoSellNote(state)}` : ''}`)) return;
    if (rule.state !== 'stopped') {
      const saved = await call('policy', '/policy', 'PUT', { policy: { pool: pool.address, state: 'stopped', capUsd: rule.capUsd, auto: rule.auto } });
      if (!saved) return;
    }
    if (!exitAll) { onStarted('本池已停止。'); onClose(); return; }
    if (await execute('exitPool', { pool: pool.address, ...(exitToken ? { exitToken } : {}), ...(acceptPenalty ? { acceptPenalty: true } : {}) })) { onStarted('本池已停止，已开始整池平仓，进度见上方任务状态。'); onClose(); }
  };
  return <div className="as-form as-inline" role="group" aria-label={`停止 ${pool.name}`}>
    <label className="as-check"><input type="checkbox" checked={exitAll} onChange={(e) => setExitAll(e.target.checked)} />同时平掉本池全部头寸</label>
    {exitAll ? <label>平仓后<select value={exitToken} onChange={(e) => setExitToken(e.target.value)}>
      <option value="">保留两种币</option>
      {targets.map((t) => <option key={t} value={t}>全部换成 {symbolOf(state, t)}</option>)}
    </select></label> : null}
    {exitAll && locked.length ? <label className="as-check"><input type="checkbox" checked={acceptPenalty} onChange={(e) => setAcceptPenalty(e.target.checked)} />接受罚没（{locked.length} 个头寸在罚没期内）</label> : null}
    <button type="button" className="button primary" disabled={!!busy || (exitAll && locked.length > 0 && !acceptPenalty)} onClick={() => void submit()}>{busy === 'policy' || busy === 'exitPool' ? <LoaderCircle size={15} className="spin" /> : null}确认停止</button>
    <button type="button" className="as-link" onClick={onClose}>取消</button>
    {exitAll && !targets.length ? <small className="as-muted">白名单里没有本池两种币互换的路径，只能保留两种币。</small> : null}
  </div>;
}

const SHARE_PRESETS = [25, 50, 100];
// 减仓或平仓一个头寸，可选换成本池的一种币。100% 为平仓（销毁 NFT）。
export function Withdraw({ safe, pool, position, penalty, onClose, onStarted }: { safe: AeroSafe; pool: AeroSafePool; position: AeroSafePosition; penalty: boolean; onClose: () => void; onStarted: (text: string) => void }) {
  const { state, busy, execute } = safe;
  const [shareText, setShareText] = useState('50');
  const [exitToken, setExitToken] = useState('');
  const [acceptPenalty, setAcceptPenalty] = useState(false);
  if (!state) return null;
  const share = Number(shareText);
  const shareBps = /^\d+(\.\d{1,2})?$/.test(shareText.trim()) && share > 0 && share <= 100 ? Math.round(share * 100) : null;
  const targets = exitTokens(state, pool);
  const full = shareBps === 10_000;
  const submit = async () => {
    if (shareBps === null) return;
    const what = full ? '平仓（解押后撤出全部流动性并销毁 NFT，代币回到 Safe）' : `减仓 ${shareBps / 100}%（撤出这部分流动性与未领手续费，代币回到 Safe${position.staked ? '；之后重新质押，罚没期从重新质押起算' : ''}）`;
    const warning = penalty ? '\n\n头寸仍在提前解押罚没期内，继续将被罚没部分奖励。' : '';
    if (!window.confirm(`${pool.name} #${position.tokenId}：${what}？${warning}${exitNote(state, pool, exitToken)}${autoSellNote(state)}`)) return;
    const params = { tokenId: position.tokenId, ...(exitToken ? { exitToken } : {}), ...(penalty ? { acceptPenalty: true } : {}) };
    const done = await execute(full ? 'close' : 'reduce', full ? params : { ...params, shareBps });
    if (done) { onStarted(`已开始${full ? '平仓' : '减仓'}，进度见上方任务状态。`); onClose(); }
  };
  return <div className="as-form as-inline" role="group" aria-label={`减仓 #${position.tokenId}`}>
    <span>撤出</span>
    {SHARE_PRESETS.map((p) => <button key={p} type="button" className={`button ${shareBps === p * 100 ? 'primary' : 'secondary'}`} onClick={() => setShareText(String(p))}>{p === 100 ? '全部（平仓）' : `${p}%`}</button>)}
    <label>比例（%）<input type="number" min={0.01} max={100} step={0.01} value={shareText} onChange={(e) => setShareText(e.target.value)} /></label>
    <label>撤出后<select value={exitToken} onChange={(e) => setExitToken(e.target.value)}>
      <option value="">保留两种币</option>
      {targets.map((t) => <option key={t} value={t}>换成 {symbolOf(state, t)}</option>)}
    </select></label>
    {penalty ? <label className="as-check"><input type="checkbox" checked={acceptPenalty} onChange={(e) => setAcceptPenalty(e.target.checked)} />接受罚没</label> : null}
    <button type="button" className="button primary" disabled={!!busy || shareBps === null || (penalty && !acceptPenalty)} title={penalty && !acceptPenalty ? '头寸在罚没期内，勾选接受罚没后才能撤出' : shareBps === null ? '比例须为 0.01 到 100' : undefined} onClick={() => void submit()}>{busy === 'reduce' || busy === 'close' ? <LoaderCircle size={15} className="spin" /> : null}{full ? '平仓' : '减仓'}</button>
    <button type="button" className="as-link" onClick={onClose}>取消</button>
  </div>;
}
