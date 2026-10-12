"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { monitors } from './monitors';
import { parseMonitorRuntime, type MonitorRuntimeMap } from './monitor-control';
import { startActivityPolling } from './polling';

export function useMonitorControls(initial: MonitorRuntimeMap | undefined, active: boolean) {
  const [runtime, setRuntime] = useState<MonitorRuntimeMap>(initial ?? {});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const busy = useRef(new Set<string>());
  const merge = useCallback((next: MonitorRuntimeMap) => setRuntime(previous => {
    const merged = { ...previous };
    for (const [id, value] of Object.entries(next)) if (!previous[id] || value.revision >= previous[id].revision) merged[id] = value;
    return merged;
  }), []);
  const load = useCallback(async (signal: AbortSignal) => {
    const response = await fetch('/api/monitors', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取监控开关，稍后自动重试。');
    const body = await response.json() as { monitors?: { id: string; runtime: unknown }[] };
    return Object.fromEntries(monitors.map(({ id }) => {
      const value = parseMonitorRuntime(body.monitors?.find((item: { id: string }) => item.id === id)?.runtime);
      if (value.monitorId !== id) throw new Error('监控开关状态无效');
      return [id, value];
    }));
  }, []);
  useEffect(() => {
    const polling = startActivityPolling({ active, intervalMs: 10_000, load,
      onData(value) { merge(value); setErrors(previous => ({ ...previous, load: '' })); },
      onError() { setErrors(previous => ({ ...previous, load: '无法读取监控开关，稍后自动重试。' })); },
    });
    return () => polling.stop();
  }, [active, load, merge]);
  const toggle = async (id: string) => {
    const current = runtime[id];
    if (!current?.available || busy.current.has(id)) return;
    busy.current.add(id); setPending(previous => ({ ...previous, [id]: true }));
    setErrors(previous => ({ ...previous, [id]: '' }));
    try {
      const response = await fetch(`/api/monitors/${id}/runtime`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: current.error ? current.enabled : !current.enabled, revision: current.revision }), signal: AbortSignal.timeout(60_000) });
      const value = await response.json();
      if (!response.ok) throw new Error((value as { error?: string }).error || '监控开关保存失败，请重试。');
      merge({ [id]: parseMonitorRuntime(value) });
    } catch (error) {
      setErrors(previous => ({ ...previous, [id]: error instanceof Error && error.name !== 'TimeoutError' ? error.message : '切换结果尚未确认，正在重新读取状态。' }));
      try { merge(await load(AbortSignal.timeout(15_000))); } catch { /* Retain the last confirmed state. */ }
    } finally { busy.current.delete(id); setPending(previous => ({ ...previous, [id]: false })); }
  };
  return { runtime, pending, errors, toggle };
}
