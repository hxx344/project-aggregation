import { useEffect, useState } from 'react';
import type { LiveView } from './live-types';
import type { OpenCapacity, OpenCapacityInput } from './open-capacity';
import { capacityIsFresh, parseOpenCapacity } from './open-capacity';
import { createLatestRead } from './latest-read';
import { observeReadWake, readPollDelay } from './hub-bridge';

export type CapacityContext = { live: LiveView; active: boolean; background: boolean; csrfToken: string; revision: string; now: number; readNow: () => number };

export function useOpenCapacity(input: OpenCapacityInput | null, { live, active, background, csrfToken, revision, now, readNow }: CapacityContext) {
  const inputKey = input ? JSON.stringify(input) : '';
  const version = live.connection.version;
  const scope = JSON.stringify([inputKey, version, revision, csrfToken]);
  const enabled = !!inputKey && !!csrfToken && active && live.connection.configured && !live.stale && !live.partial;
  const [result, setResult] = useState<{ scope: string; data: OpenCapacity | null; error: string }>({ scope: '', data: null, error: '' });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, epoch = 0, nextDelay = 4000, timer: ReturnType<typeof setTimeout> | undefined;
    const request: OpenCapacityInput = JSON.parse(inputKey);
    const reader = createLatestRead<OpenCapacity>({
      canRead: () => !disposed,
      load: async signal => {
        const response = await fetch('/api/live/open-capacity', { method: 'POST', cache: 'no-store', signal,
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: inputKey });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '开仓估算暂不可用');
        return parseOpenCapacity(data, request, version);
      },
      onData: data => {
        nextDelay = data.status === 'unavailable' ? 5000 : Math.max(1000, Math.min(4000, data.expiresAt - readNow() - 700));
        setResult({ scope, data, error: '' });
      },
      onError: cause => { nextDelay = 5000; setResult({ scope, data: null, error: cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '开仓估算读取超时，稍后自动重试' }); },
    });
    const synchronize = () => {
      const own = ++epoch; clearTimeout(timer); reader.cancel();
      setResult({ scope, data: null, error: '' });
      const poll = async () => {
        if (disposed || own !== epoch) return;
        await reader.refresh();
        if (!disposed && own === epoch) timer = setTimeout(poll, readPollDelay(nextDelay, background));
      };
      timer = setTimeout(() => void poll(), 300);
    };
    synchronize(); const stopWake = observeReadWake(synchronize);
    return () => { disposed = true; epoch++; clearTimeout(timer); reader.cancel(); stopWake(); };
  }, [enabled, inputKey, version, revision, csrfToken, scope, background, readNow]);

  const current = enabled && result.scope === scope ? result : null;
  const data = current?.data && capacityIsFresh(current.data, now) ? current.data : null;
  const error = !live.connection.configured ? '连接账户后显示可开仓额度'
    : live.stale || live.partial ? '账户数据待更新，暂不能估算'
      : !active ? '页面暂停读取，返回后重新估算'
        : !input ? '选择合约并填写有效参数后估算'
          : current?.error || (current?.data?.status === 'unavailable' ? current.data.reason || '开仓估算暂不可用'
            : current?.data && !data ? '估算已过期，等待更新' : '');
  return { data, error, loading: enabled && !current?.data && !current?.error };
}
