import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { browserEnvironment, createResourceStore, type ResourceSnapshot } from './live-resource';

// 工作台只读页面的共享读取入口，调度与失效规则见 live-resource.ts。
const store = createResourceStore(browserEnvironment());

export type LiveResource<T> = ResourceSnapshot<T> & {
  // 立即重读，之前发出的读取作废。
  refresh: () => Promise<void>;
  // 写操作确认后的结果直接成为当前值，之前发出的读取作废。
  commit: (data: T) => void;
};

type Options<T> = {
  // null 表示只在打开时读取一次，之后靠 refresh。
  intervalMs: number | null;
  timeoutMs?: number;
  // 边界校验：抛错按读取失败处理，不覆盖上次结果。
  parse?: (raw: unknown) => T;
  // false 时不订阅，保留本组件上次看到的数据，状态为 paused。
  enabled?: boolean;
  onExpired: () => void;
};

const initial = <T,>(enabled: boolean): ResourceSnapshot<T> => ({ data: null, error: null, status: enabled ? 'loading' : 'paused', receivedAt: null });

// 同一 path 的订阅者共享请求与结果，读取函数、超时与校验以第一个订阅者为准，
// 所以共享同一 path 的页面须使用相同的 timeoutMs 与 parse。
export function useLiveResource<T>(path: string, { intervalMs, timeoutMs = 10_000, parse, enabled = true, onExpired }: Options<T>): LiveResource<T> {
  const [state, setState] = useState<{ path: string; snapshot: ResourceSnapshot<T> }>(() => ({ path, snapshot: initial<T>(enabled) }));
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const parser = useRef(parse);
  parser.current = parse;
  const handled = useRef<Error | null>(null);
  useEffect(() => {
    if (!enabled) {
      setState(current => current.path === path ? (current.snapshot.status === 'paused' ? current : { path, snapshot: { ...current.snapshot, status: 'paused' } }) : { path, snapshot: initial<T>(false) });
      return undefined;
    }
    const read = async (signal: AbortSignal) => {
      const raw = await api<unknown>(path, { signal, timeoutMs });
      return parser.current ? parser.current(raw) : raw as T;
    };
    return store.subscribe<T>(path, { read, intervalMs }, snapshot => {
      if (snapshot.error instanceof ApiError && snapshot.error.status === 401 && snapshot.error !== handled.current) { handled.current = snapshot.error; expired.current(); }
      setState(current => {
        // 共享条目刚建立、还没有结果时，保留本组件上次看到的数据；状态以共享条目为准。
        const keep = current.path === path && snapshot.data === null && current.snapshot.data !== null;
        return { path, snapshot: keep ? { ...snapshot, data: current.snapshot.data, receivedAt: current.snapshot.receivedAt } : snapshot };
      });
    });
  }, [path, enabled, intervalMs, timeoutMs]);
  const refresh = useCallback(() => store.refresh(path), [path]);
  const commit = useCallback((data: T) => store.commit(path, data), [path]);
  return { ...(state.path === path ? state.snapshot : initial<T>(enabled)), refresh, commit };
}
