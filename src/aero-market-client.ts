import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { clearCache, readCache, writeCache } from './aero-market-cache';
import { message } from './aero-market-format';
import type { MarketSnapshot, MarketUnchanged } from './aero-market-types';

export const AERO_MARKET_ROOT = '/api/research/aero-market';

// 本地缓存不存 RPC 地址或节点诊断文本；显示缓存期间扫描设置不可用，等服务器的完整数据。
const forCache = (data: MarketSnapshot): MarketSnapshot => ({
  ...data, config: { ...data.config, chains: Object.fromEntries(Object.entries(data.config.chains).map(([id, c]) => [id, { ...c, rpcUrl: '' }])) },
  chains: data.chains.map((c) => ({ ...c, error: null, discovery: c.discovery ? { ...c.discovery, error: null } : undefined })),
});
const usableSnapshot = (data: unknown): data is MarketSnapshot => {
  const d = data as MarketSnapshot | null;
  return !!d && d.schema === 1 && Array.isArray(d.pools) && Array.isArray(d.chains) && !!d.config && typeof d.config.chains === 'object' && !!d.aero;
};

// Aero 模块共用的行情快照：先显示本机缓存，再每 30 秒按 revision 向服务器增量读取。
// 仓位、行情与配置三个标签共享一份，切换标签不重新下载。
export function useAeroMarket(onExpired: () => void) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const revision = useRef<number | null>(null);
  const generation = useRef(0);
  const fail = useCallback((reason: unknown, show: (text: string) => void) => { if (reason instanceof ApiError && reason.status === 401) onExpired(); else show(message(reason)); }, [onExpired]);
  const accept = useCallback((data: MarketSnapshot) => {
    revision.current = data.revision; setSnapshot(data); setCachedAt(null); setLoadError('');
    void writeCache('snapshot', forCache(data));
  }, []);
  const read = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const version = ++generation.current;
    try {
      const data = await api<MarketSnapshot | MarketUnchanged>(revision.current === null ? AERO_MARKET_ROOT : `${AERO_MARKET_ROOT}?revision=${revision.current}`, { signal, timeoutMs: 20_000 });
      if (signal.aborted || version !== generation.current) return;
      if (data.unchanged) { setLoadError(''); setSnapshot((s) => (s ? { ...s, serverNow: data.serverNow } : s)); } else accept(data);
    } catch (reason) { if (!signal.aborted && version === generation.current) fail(reason, setLoadError); }
  }, [accept, fail]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    // 先显示本机缓存，服务器的数据到了再替换；服务器先到（revision 已有值）时缓存直接作废。
    void readCache<MarketSnapshot>('snapshot').then((hit) => {
      if (!hit || controller.signal.aborted || revision.current !== null || !usableSnapshot(hit.data)) return;
      // 旧版缓存可能已含节点回显。清空该副本，保留内存里的去诊断投影，下一次服务器返回再缓存。
      if (hit.data.chains.some((c) => c.error || c.discovery?.error) || Object.values(hit.data.config.chains).some((c) => c.rpcUrl)) void clearCache();
      setSnapshot(forCache(hit.data)); setCachedAt(hit.savedAt);
    });
    void read();
    const poll = setInterval(() => { if (!document.hidden) void read(); }, 30_000);
    return () => { controller.abort(); clearInterval(poll); };
  }, [read]);
  // 写操作：成功返回 true 并接收新快照；失败把错误放进 actionError。
  const execute = async (name: string, path: string, method: string, body: unknown) => {
    const signal = lifetime.current?.signal;
    if (!signal || busy) return false;
    generation.current++;
    setBusy(name); setActionError('');
    try { const data = await api<MarketSnapshot>(AERO_MARKET_ROOT + path, { method, body: JSON.stringify(body), signal, timeoutMs: 20_000 }); if (!signal.aborted) accept(data); return !signal.aborted; }
    catch (reason) { if (!signal.aborted) fail(reason, setActionError); return false; }
    finally { if (!signal.aborted) setBusy(''); }
  };
  return { snapshot, cachedAt, loadError, actionError, setActionError, busy, read, execute, accept, fail, lifetime, generation };
}
export type AeroMarket = ReturnType<typeof useAeroMarket>;
