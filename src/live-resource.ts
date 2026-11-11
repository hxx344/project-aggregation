// 只读页面共用的读取层：同一地址的多个订阅者共享一个请求和一份结果。
// 读取约定：
// - 同一 key 同时只有一个在途读取；间隔取所有订阅者的最小值，读取结束后再排下一次，不重叠。
// - 页面隐藏或离线时中止在途读取并暂停；恢复后立即读取，旧结果保留但状态不再是 ready。
// - 失败保留上次结果并报告错误，按原间隔重试；401 不再自动重试，由页面处理登录过期。
// - 写操作（commit、refresh）使之前发出的读取失效，迟到的旧响应不能覆盖写入结果（L089）。
// - 缓存只在仍有订阅者时存在：最后一个订阅者离开即中止读取并丢弃结果，不跨页面或会话复用。

export type ResourceStatus = 'loading' | 'ready' | 'error' | 'paused' | 'offline';
export type ResourceSnapshot<T> = { data: T | null; error: Error | null; status: ResourceStatus; receivedAt: number | null };
export type ResourceSource<T> = { read: (signal: AbortSignal) => Promise<T>; intervalMs: number | null };
export type Subscription = (() => void) & { retune: (intervalMs: number | null) => void };

export type ResourceEnvironment = {
  now: () => number;
  hidden: () => boolean;
  online: () => boolean;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  // 订阅可见性、网络与页面恢复事件；返回取消函数。
  listen: (wake: () => void) => () => void;
};

type Subscriber = { intervalMs: number | null; listener: (snapshot: ResourceSnapshot<unknown>) => void };
type Entry = {
  read: (signal: AbortSignal) => Promise<unknown>;
  subscribers: Set<Subscriber>;
  snapshot: ResourceSnapshot<unknown>;
  generation: number;
  request: { controller: AbortController; done: Promise<void> } | null;
  timer: unknown;
  lastAttemptAt: number | null;
  stopped: boolean;
  // 暂停时打断了读取（或还没读过）；一次性资源只有这种情况在恢复后重读。
  interrupted: boolean;
};

export function browserEnvironment(): ResourceEnvironment {
  return {
    now: () => Date.now(),
    hidden: () => document.hidden,
    online: () => navigator.onLine,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    listen: wake => {
      document.addEventListener('visibilitychange', wake);
      for (const name of ['online', 'offline', 'focus', 'pageshow']) window.addEventListener(name, wake);
      return () => {
        document.removeEventListener('visibilitychange', wake);
        for (const name of ['online', 'offline', 'focus', 'pageshow']) window.removeEventListener(name, wake);
      };
    },
  };
}

const unauthorized = (error: unknown) => !!error && typeof error === 'object' && (error as { status?: unknown }).status === 401;

export function createResourceStore(env: ResourceEnvironment) {
  const entries = new Map<string, Entry>();
  let unlisten: (() => void) | null = null;
  const readable = () => !env.hidden() && env.online();
  const interval = (entry: Entry) => {
    let min: number | null = null;
    for (const subscriber of entry.subscribers) if (subscriber.intervalMs !== null) min = min === null ? subscriber.intervalMs : Math.min(min, subscriber.intervalMs);
    return min;
  };
  const publish = (entry: Entry, next: Partial<ResourceSnapshot<unknown>>) => {
    entry.snapshot = { ...entry.snapshot, ...next };
    for (const subscriber of [...entry.subscribers]) subscriber.listener(entry.snapshot);
  };
  const cancel = (entry: Entry) => {
    entry.generation++;
    entry.request?.controller.abort();
    entry.request = null;
    env.clearTimer(entry.timer); entry.timer = undefined;
  };
  const schedule = (key: string, entry: Entry) => {
    env.clearTimer(entry.timer); entry.timer = undefined;
    const ms = interval(entry);
    if (ms === null || entry.stopped || entry.request || !readable()) return;
    const wait = entry.lastAttemptAt === null ? 0 : Math.max(0, entry.lastAttemptAt + ms - env.now());
    entry.timer = env.setTimer(() => { entry.timer = undefined; void start(key, entry); }, wait);
  };
  const start = (key: string, entry: Entry): Promise<void> => {
    if (entries.get(key) !== entry) return Promise.resolve();
    // 不可读时记下这次显式要求的重读（如写入后的 refresh），恢复后补读，不能被吞掉。
    if (!readable()) { entry.stopped = false; entry.interrupted = true; suspend(entry); return Promise.resolve(); }
    cancel(entry);
    entry.stopped = false; entry.interrupted = false;
    const version = entry.generation;
    // 先登记在途请求再发起读取：读取函数同步抛错时也不会留下无人清理的请求标记。
    const request = { controller: new AbortController(), done: Promise.resolve() };
    entry.request = request;
    entry.lastAttemptAt = env.now();
    publish(entry, { status: 'loading' });
    request.done = (async () => {
      let value: unknown, failure: unknown, ok = false;
      try { value = await entry.read(request.controller.signal); ok = true; } catch (error) { failure = error; }
      if (request.controller.signal.aborted || version !== entry.generation || entry.request !== request || entries.get(key) !== entry) return;
      entry.request = null;
      if (ok) publish(entry, { data: value, error: null, status: 'ready', receivedAt: env.now() });
      else {
        entry.stopped = unauthorized(failure);
        publish(entry, { error: failure instanceof Error ? failure : new Error('读取失败，请稍后重试。'), status: 'error' });
      }
      schedule(key, entry);
    })();
    return request.done;
  };
  const suspend = (entry: Entry) => {
    if (entry.request || entry.lastAttemptAt === null) entry.interrupted = true;
    cancel(entry);
    const status: ResourceStatus = env.online() ? 'paused' : 'offline';
    if (entry.snapshot.status !== status) publish(entry, { status });
  };
  // 新订阅者或更短的间隔：按当前最小间隔判断是否已到期，到期立即读，否则重排计时器。
  const catchUp = (key: string, entry: Entry) => {
    if (entry.request || entry.stopped) return;
    const ms = interval(entry);
    if (entry.lastAttemptAt === null || ms !== null && env.now() - entry.lastAttemptAt >= ms) void start(key, entry);
    else schedule(key, entry);
  };
  const wake = () => {
    for (const [key, entry] of entries) {
      if (!readable()) { suspend(entry); continue; }
      const suspended = entry.snapshot.status === 'paused' || entry.snapshot.status === 'offline';
      // 登录过期后不自动重试，恢复前台时仍显示为读取失败。
      if (entry.stopped) { if (suspended) publish(entry, { status: 'error' }); continue; }
      if (entry.request) continue;
      const ms = interval(entry);
      // 后台计时器可能被浏览器节流：恢复前台时补读已到期的资源；轮询资源暂停后一律重读。
      if (suspended && (ms !== null || entry.interrupted) || ms !== null && (entry.lastAttemptAt === null || env.now() - entry.lastAttemptAt >= ms)) void start(key, entry);
      else if (suspended) publish(entry, { status: entry.snapshot.error ? 'error' : 'ready' });
      else schedule(key, entry);
    }
  };

  return {
    subscribe<T>(key: string, source: ResourceSource<T>, listener: (snapshot: ResourceSnapshot<T>) => void): Subscription {
      let entry = entries.get(key);
      if (!entry) {
        entry = { read: source.read, subscribers: new Set(), snapshot: { data: null, error: null, status: 'loading', receivedAt: null }, generation: 0, request: null, timer: undefined, lastAttemptAt: null, stopped: false, interrupted: false };
        entries.set(key, entry);
        unlisten ??= env.listen(wake);
      }
      const subscriber: Subscriber = { intervalMs: source.intervalMs, listener: listener as Subscriber['listener'] };
      entry.subscribers.add(subscriber);
      const current = entry;
      if (!readable()) suspend(current);
      else catchUp(key, current);
      listener(current.snapshot as ResourceSnapshot<T>);
      const leave = () => {
        if (!current.subscribers.delete(subscriber)) return;
        if (current.subscribers.size) { schedule(key, current); return; }
        cancel(current); entries.delete(key);
        if (!entries.size) { unlisten?.(); unlisten = null; }
      };
      // 调整本订阅者的间隔（如探测运行中改为 3 秒），不中止在途读取、不丢弃结果。
      const retune = (ms: number | null) => {
        if (subscriber.intervalMs === ms || !current.subscribers.has(subscriber)) return;
        subscriber.intervalMs = ms;
        if (readable()) catchUp(key, current);
      };
      return Object.assign(leave, { retune });
    },
    // 立即重新读取：之前发出的读取作废，结束后恢复轮询。
    refresh(key: string): Promise<void> {
      const entry = entries.get(key);
      return entry ? start(key, entry) : Promise.resolve();
    },
    // 写操作返回的结果直接成为当前值；之前发出的读取作废，下一次轮询从现在起算。
    commit<T>(key: string, data: T) {
      const entry = entries.get(key);
      if (!entry) return;
      cancel(entry);
      entry.stopped = false; entry.interrupted = false; entry.lastAttemptAt = env.now();
      publish(entry, { data, error: null, status: 'ready', receivedAt: env.now() });
      schedule(key, entry);
    },
  };
}

export type ResourceStore = ReturnType<typeof createResourceStore>;
