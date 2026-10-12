import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { monitors } from '../lib/monitors.ts';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export async function openMonitorControlStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'monitor-control.json');
  let state = { version: 1, monitors: Object.fromEntries(monitors.map(({ id }) => [id, { enabled: true, revision: 0 }])) };
  try {
    const text = await readFile(file, 'utf8'), loaded = JSON.parse(text);
    if (text.length > 16_384 || loaded.version !== 1 || !loaded.monitors || Object.keys(loaded.monitors).some(id => !Object.hasOwn(state.monitors, id))) throw Error('Invalid state');
    for (const { id } of monitors) {
      // Version 1 installations predate this module; retain all original switches.
      if (id === 'cl-xau' && !Object.hasOwn(loaded.monitors, id)) continue;
      const value = loaded.monitors[id];
      if (!value || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw Error('Invalid state');
      state.monitors[id] = { enabled: value.enabled, revision: value.revision };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('监控开关无法读取，请修复或恢复 monitor-control.json。', { cause: error });
  }
  return {
    get: () => structuredClone(state),
    async save(next) {
      const copy = structuredClone(next), temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify(copy)}\n`, { mode: 0o600 }); await rename(temporary, file); state = copy; }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    },
  };
}

/** Serialize persistence and lifecycle changes; closed modules never fall through to web adapters. */
export function attachMonitorControl(services, store, { collector, factories = {} } = {}) {
  let queue = Promise.resolve();
  const entries = new Map();
  const serial = action => { const result = queue.then(action); queue = result.catch(() => {}); return result; };
  const view = id => ({ available: true, monitorId: id, ...store.get().monitors[id], running: entries.get(id).running, error: entries.get(id).error });
  const ensureOpen = id => {
    const entry = entries.get(id);
    if (!store.get().monitors[id].enabled || entry.changing || entry.disposed || entry.error) throw failure('该监控已关闭或正在切换，请开启后重试。', 423);
    return entry;
  };
  async function start(id) {
    const entry = entries.get(id);
    if (entry.running || !store.get().monitors[id].enabled) return;
    if (entry.disposed) { entry.backend = await factories[id](); entry.disposed = false; }
    await entry.backend.start();
    collector?.resume(id);
    entry.running = true; entry.error = '';
  }
  async function stop(id) {
    const entry = entries.get(id);
    entry.running = false;
    entry.backend.closeStreams?.();
    const paused = collector?.pause(id);
    await Promise.allSettled([...entry.pending]);
    await Promise.all([paused, entry.disposed ? undefined : entry.backend.stop()]);
    if (factories[id]) entry.disposed = true;
  }
  async function update(id, input) {
    return serial(async () => {
      if (!input || Object.keys(input).some(key => !['enabled', 'revision'].includes(key)) || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.revision) || input.revision < 0) throw failure('请提供监控开关和有效版本号。');
      const previous = store.get(), current = previous.monitors[id], entry = entries.get(id);
      if (input.revision !== current.revision) throw failure('开关已被其他页面修改，请刷新状态后重试。', 409);
      if (input.enabled === current.enabled && !entry.error) return view(id);
      const next = structuredClone(previous);
      next.monitors[id] = { enabled: input.enabled, revision: current.revision + 1 };
      await store.save(next);
      entry.changing = true;
      try {
        if (input.enabled) await start(id); else await stop(id);
        entry.error = '';
      } catch {
        entry.error = '监控切换未完成，请重试或检查服务日志。';
        throw failure(entry.error, 503);
      } finally { entry.changing = false; }
      return view(id);
    });
  }
  for (const [id, backend] of services) {
    entries.set(id, { backend, running: false, changing: false, disposed: false, error: '', pending: new Set() });
    if (!store.get().monitors[id].enabled) void collector?.pause(id);
    services.set(id, {
      actions: { ...backend.actions, runtime: ['GET', 'PUT'] },
      runtime: () => view(id),
      start: () => serial(() => start(id)),
      stop: () => serial(() => stop(id)),
      healthy: () => !entries.get(id).error && (!store.get().monitors[id].enabled || (entries.get(id).backend.healthy?.() ?? true)),
      closeStreams: () => entries.get(id).backend.closeStreams?.(),
      summary() { ensureOpen(id); return entries.get(id).backend.summary?.(); },
      stream(request, response) { return ensureOpen(id).backend.stream(request, response); },
      async handle(action, method, input) {
        if (action === 'runtime') return method === 'PUT' ? update(id, input) : view(id);
        const entry = ensureOpen(id);
        const pending = Promise.resolve().then(() => entry.backend.handle(action, method, input));
        entry.pending.add(pending);
        try { return await pending; } finally { entry.pending.delete(pending); }
      },
    });
  }
  services.controls = { view: () => Object.fromEntries([...entries.keys()].map(id => [id, view(id)])) };
  return services;
}
