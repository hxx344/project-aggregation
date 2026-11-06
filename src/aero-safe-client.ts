import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { AeroSafeAction, AeroSafeChain, AeroSafeChangeBatch, AeroSafePreview, AeroSafeState } from './aero-safe-types';

export const AERO_SAFE_ROOT = '/api/automation/aero-safe';
// 加池、生成批次、核对启用：服务端从收到请求起 50 秒内（含排队）给出结果，API 转发时限 60 秒；
// 页面等得比二者都长，让知道原因的一层先回复。
export const CHANGE_TIMEOUT_MS = 70_000;
const message = (reason: unknown) => (reason instanceof Error ? reason.message : '请求失败，请重试。');

// 原始单位 → 展示：按精度移位后最多 6 位有效数字；非常小的值显示为下界。
export function units(raw: string | number | null | undefined, decimals: number) {
  if (raw === null || raw === undefined || raw === '') return '—';
  let value: bigint;
  try { value = BigInt(raw); } catch { return '—'; }
  if (value === 0n) return '0';
  const negative = value < 0n, abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals), whole = abs / scale, fraction = (abs % scale).toString().padStart(decimals, '0');
  const n = Number(`${whole}.${fraction.slice(0, 18) || '0'}`);
  if (n < 0.000001) return negative ? '>-0.000001' : '<0.000001';
  return `${negative ? '-' : ''}${new Intl.NumberFormat('zh-CN', n >= 1000 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 6 }).format(n)}`;
}
export const tokenOf = (chain: AeroSafeChain | null | undefined, address: string) => chain?.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
export const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
// 原始单位的十进制字符串 → 精确的代币数量文本（不舍入，供填回输入框）。
export function exactUnits(raw: string, decimals: number) {
  const value = BigInt(raw), scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${value / scale}.${fraction}` : `${value / scale}`;
}
// 代币数量文本 → 原始单位字符串；格式不符、超出精度或不为正时为 null。
export function rawUnits(text: string, decimals: number) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match || (match[2]?.length ?? 0) > decimals) return null;
  const raw = BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] ?? '').padEnd(decimals, '0') || '0');
  return raw > 0n ? String(raw) : null;
}
// 行情里的池子在白名单（同代币对与 tickSpacing）或待加池里（按地址）。
export function poolStatus(state: AeroSafeState | null | undefined, pool: { address: string; tickSpacing: number; token0: { address: string }; token1: { address: string } }): 'listed' | 'queued' | null {
  if (state?.config?.permissions.pools.some((p) => same(p.token0, pool.token0.address) && same(p.token1, pool.token1.address) && p.tickSpacing === pool.tickSpacing)) return 'listed';
  if (state?.changes?.pools.some((p) => same(p.address, pool.address))) return 'queued';
  return null;
}

// 页面与池详情面板共用：任务运行或交易待确认时每 3 秒轮询，否则 15 秒。
export function useAeroSafe(onExpired: () => void) {
  const [state, setState] = useState<AeroSafeState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const lifetime = useRef<AbortController | null>(null), busyRef = useRef(''), generation = useRef(0);
  const fail = useCallback((reason: unknown, set: (text: string) => void) => {
    if (reason instanceof ApiError && reason.status === 401) onExpired(); else set(message(reason));
  }, [onExpired]);
  const read = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || document.hidden) return;
    const version = ++generation.current;
    try { const data = await api<AeroSafeState>(AERO_SAFE_ROOT, { signal, timeoutMs: 10_000 }); if (!signal.aborted && version === generation.current) { setState(data); setLoadError(''); } }
    catch (reason) { if (!signal.aborted && version === generation.current) fail(reason, setLoadError); }
  }, [fail]);
  const active = !!state && (state.job?.status === 'running' || state.refreshing || !!state.pending);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void read();
    return () => controller.abort();
  }, [read]);
  useEffect(() => {
    const poll = setInterval(() => { if (!busyRef.current) void read(); }, active ? 3000 : 15_000);
    const visibility = () => { if (!document.hidden && !busyRef.current) void read(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(poll); document.removeEventListener('visibilitychange', visibility); };
  }, [read, active]);
  // 写操作：成功返回最新状态；失败把错误放进 actionError 并返回 null。
  const call = useCallback(async (name: string, path: string, method: 'PUT' | 'POST', body: unknown, timeoutMs = 20_000): Promise<AeroSafeState | null> => {
    const signal = lifetime.current?.signal;
    if (busyRef.current || !signal || signal.aborted) return null;
    busyRef.current = name; setBusy(name); setActionError('');
    generation.current++;
    try { const data = await api<AeroSafeState>(AERO_SAFE_ROOT + path, { method, body: JSON.stringify(body), signal, timeoutMs }); if (!signal.aborted) setState(data); return data; }
    catch (reason) { if (!signal.aborted) fail(reason, setActionError); return null; }
    finally { busyRef.current = ''; if (!signal.aborted) setBusy(''); }
  }, [fail]);
  const execute = useCallback((action: AeroSafeAction, params: Record<string, unknown>) => call(action, '/execute', 'POST', { action, params }, 60_000), [call]);
  const preview = useCallback(async (params: Record<string, unknown>): Promise<AeroSafePreview | null> => {
    const signal = lifetime.current?.signal;
    if (busyRef.current || !signal || signal.aborted) return null;
    busyRef.current = 'preview'; setBusy('preview'); setActionError('');
    try { return await api<AeroSafePreview>(`${AERO_SAFE_ROOT}/preview`, { method: 'POST', body: JSON.stringify({ params }), signal, timeoutMs: 60_000 }); }
    catch (reason) { if (!signal.aborted) fail(reason, setActionError); return null; }
    finally { busyRef.current = ''; if (!signal.aborted) setBusy(''); }
  }, [fail]);
  // 生成白名单变更批次：成功时同步最新状态并返回批次；失败放进 actionError 返回 null。
  const buildBatch = useCallback(async (): Promise<AeroSafeChangeBatch | null> => {
    const signal = lifetime.current?.signal;
    if (busyRef.current || !signal || signal.aborted) return null;
    busyRef.current = 'batch'; setBusy('batch'); setActionError('');
    generation.current++;
    try { const data = await api<AeroSafeChangeBatch>(`${AERO_SAFE_ROOT}/changes/batch`, { method: 'POST', body: '{}', signal, timeoutMs: CHANGE_TIMEOUT_MS }); if (!signal.aborted) setState(data.state); return data; }
    catch (reason) { if (!signal.aborted) fail(reason, setActionError); return null; }
    finally { busyRef.current = ''; if (!signal.aborted) setBusy(''); }
  }, [fail]);
  return { state, loadError, busy, actionError, setActionError, read, call, execute, preview, buildBatch };
}
export type AeroSafe = ReturnType<typeof useAeroSafe>;

// 领取后自动卖出走第一条卖出 AERO 的白名单路径（与服务端 sellRewards 一致）；返回目标代币符号，没有路径时为 null。
export function rewardSellTarget(state: AeroSafeState | null) {
  const aero = state?.chain?.tokens.find((t) => t.symbol === 'AERO');
  const route = aero ? state?.config?.permissions.swaps.find((s) => same(s.tokenIn, aero.address)) : undefined;
  return route ? tokenOf(state?.chain, route.tokenOut)?.symbol ?? route.tokenOut : null;
}

// 领取、解押、平仓之后的自动卖出说明，写进确认框。
export function autoSellNote(state: AeroSafeState | null) {
  const target = rewardSellTarget(state);
  if (!state?.config?.autoSellRewards || !target) return '';
  return `\n\n完成后会自动把 Safe 里的全部 AERO（不超过今日额度、不少于 ${state.config.minRewardSell}）卖成 ${target}。`;
}
