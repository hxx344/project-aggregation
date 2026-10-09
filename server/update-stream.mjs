import { publicUpdateState, unavailableUpdateState, UpdateError } from './updates.mjs';

/** One local status reader per Hub process, shared by every subscribed browser. */
export function createUpdateStream({ readState, isSessionActive, idleMs = 5000, activeMs = 2000, heartbeatMs = 15000 }) {
  const clients = new Map();
  let closed = false, timer = null, heartbeat = null, pending = null, latest = null, encoded = '', generation = 0;
  function remove(res) {
    clients.delete(res);
    if (!clients.size) {
      clearTimeout(timer); timer = null;
      clearInterval(heartbeat); heartbeat = null;
      latest = null; encoded = ''; generation += 1;
    }
  }
  function send(res, message) {
    const id = clients.get(res);
    if (closed || res.destroyed || !isSessionActive(id)) { remove(res); res.end(); return; }
    if (res.writableLength > 256 * 1024) { remove(res); res.destroy(); return; }
    res.write(message);
  }
  function pulse() {
    for (const res of clients.keys()) send(res, 'data: {"type":"heartbeat"}\n\n');
  }
  function schedule(delay) {
    clearTimeout(timer); timer = null;
    if (!closed && clients.size) { timer = setTimeout(() => void refresh(), delay); timer.unref?.(); }
  }
  function refresh() {
    if (closed || !clients.size) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer); timer = null;
    const version = generation;
    pending = (async () => {
      let state;
      try { state = publicUpdateState(await readState()); } catch { state = unavailableUpdateState(); }
      if (closed || !clients.size || version !== generation) return;
      const value = JSON.stringify(state);
      if (value !== encoded) {
        latest = state; encoded = value;
        const message = `data: ${JSON.stringify({ type: 'snapshot', state })}\n\n`;
        for (const res of clients.keys()) send(res, message);
      }
    })().finally(() => {
      pending = null;
      schedule(version !== generation ? 0 : latest?.checking || ['queued', 'running'].includes(latest?.job?.status) ? activeMs : idleMs);
    });
    return pending;
  }
  return {
    subscribe(res, sessionId) {
      if (closed) throw new UpdateError(503, '状态订阅暂时不可用');
      if (clients.size >= 60 || [...clients.values()].filter(id => id === sessionId).length >= 12) throw new UpdateError(429, '状态订阅过多');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      clients.set(res, sessionId);
      res.once('close', () => remove(res));
      send(res, 'retry: 5000\n\n');
      if (latest) send(res, `data: ${JSON.stringify({ type: 'snapshot', state: latest })}\n\n`);
      if (!heartbeat && clients.size) { heartbeat = setInterval(pulse, heartbeatMs); heartbeat.unref?.(); }
      if (!timer && clients.size) void refresh();
    },
    refresh() { generation += 1; return refresh(); },
    revalidate: pulse,
    async close() {
      closed = true; clearTimeout(timer); clearInterval(heartbeat);
      for (const res of clients.keys()) res.end();
      clients.clear();
      await pending;
    },
  };
}
