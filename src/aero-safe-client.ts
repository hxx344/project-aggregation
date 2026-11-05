import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { AeroSafeAction, AeroSafeChain, AeroSafePreview, AeroSafeState } from './aero-safe-types';

export const AERO_SAFE_ROOT = '/api/automation/aero-safe';
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
  return { state, loadError, busy, actionError, setActionError, read, call, execute, preview };
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
