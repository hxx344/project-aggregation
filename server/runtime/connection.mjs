import http from 'node:http';
import { BUDGETS, MAX_RESPONSE_BYTES, readDiscovery, RUNTIME_KEY_HEADER, SUPPORTED_PROTOCOLS, unavailable, validateStatus } from './protocol.mjs';

// The API's link to the runtime's private socket, shared by the supervisor and
// data-plane clients. The discovery record is cached until a call reports it
// stale; concurrent callers share one identity probe, which runs on its own
// budget so no caller's deadline shortens or stretches another's.
export function createRuntimeConnection({ dir, protocols = SUPPORTED_PROTOCOLS, onInstanceChange = () => {}, probeMs = BUDGETS.read }) {
  let record = null, lastInstance = null, probing = null;

  // One HTTP exchange bounded by `deadline` (wall clock, so slow trickles end
  // too); the reply is parsed as JSON up to `maxBytes`. A failure after the
  // connection was made is `uncertain` for anything but GET and HEAD.
  function exchange(target, { method, route, headers = {}, body = null, deadline, maxBytes = MAX_RESPONSE_BYTES }) {
    return new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { reject(unavailable()); return; }
      let settled = false, connected = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
      const fail = () => finish(unavailable(!['GET', 'HEAD'].includes(method) && connected));
      const req = http.request({ socketPath: target.socketPath, path: route, method, agent: false,
        headers: { ...headers, [RUNTIME_KEY_HEADER]: target.secret, ...(body ? { 'Content-Length': body.length } : {}) } }, res => {
        const chunks = []; let size = 0;
        const abort = () => { fail(); res.destroy(); req.destroy(); };
        res.on('data', chunk => { size += chunk.length; if (size > maxBytes) abort(); else chunks.push(chunk); });
        res.on('aborted', abort); res.on('error', abort);
        res.on('end', () => {
          if (settled) return;
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(); return; }
          finish(null, { status: res.statusCode, body: value });
        });
      });
      req.on('socket', socket => { if (!socket.connecting) connected = true; else socket.once('connect', () => { connected = true; }); });
      req.on('error', fail);
      const timer = setTimeout(() => { fail(); req.destroy(); }, remaining);
      timer.unref?.();
      req.end(body);
    });
  }

  async function probe(deadline) {
    let next;
    try { next = readDiscovery(dir); } catch { throw unavailable(); }
    if (!next || !protocols.includes(next.protocol)) throw unavailable();
    // The file alone is not proof: the instance behind the socket must confirm its identity.
    const reply = await exchange(next, { method: 'GET', route: '/internal/v1/status', deadline });
    let status;
    try { if (reply.status !== 200) throw unavailable(); status = validateStatus(reply.body, protocols); } catch { throw unavailable(); }
    if (status.instanceId !== next.instanceId || status.protocol !== next.protocol) throw unavailable();
    record = next;
    const previous = lastInstance; lastInstance = next.instanceId;
    if (previous !== null && previous !== next.instanceId) { try { onInstanceChange(next.instanceId, previous); } catch { /* observer failures do not fail the call */ } }
    return record;
  }
  async function resolve(deadline) {
    if (record) return record;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw unavailable();
    // Each caller waits only until its own deadline; the shared probe carries on,
    // and its failure is handled even when every caller has already given up.
    if (!probing) { probing = probe(Date.now() + probeMs).finally(() => { probing = null; }); probing.catch(() => {}); }
    let timer;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), remaining); timer.unref?.(); });
    try { return await Promise.race([probing, expired]); } finally { clearTimeout(timer); }
  }

  // A long-lived NDJSON stream. Each complete line goes to onLine (a throw ends
  // the stream); onClose(error) runs once when the stream ends for any reason.
  // `idleMs` ends a stream that delivers nothing for that long.
  function stream(target, { route, idleMs, maxLineBytes = MAX_RESPONSE_BYTES, onLine, onClose }) {
    if (!(idleMs > 0 && idleMs <= 2 ** 31 - 1)) throw new TypeError('Runtime stream needs idleMs between 1 and 2^31-1');
    let closed = false, idle = null;
    const req = http.request({ socketPath: target.socketPath, path: route, method: 'GET', agent: false, headers: { [RUNTIME_KEY_HEADER]: target.secret } });
    const end = error => {
      if (closed) return; closed = true; clearTimeout(idle); req.destroy();
      try { onClose(error); } catch { /* observer failures do not escape */ }
    };
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => end(unavailable()), idleMs); idle.unref?.(); };
    req.on('response', res => {
      if (res.statusCode !== 200) { res.resume(); end(unavailable()); return; }
      let pending = Buffer.alloc(0);
      res.on('data', chunk => {
        if (closed) return;
        arm(); pending = Buffer.concat([pending, chunk]);
        for (let index; !closed && (index = pending.indexOf(10)) !== -1;) {
          const line = pending.subarray(0, index); pending = pending.subarray(index + 1);
          let value;
          try { value = JSON.parse(line.toString('utf8')); } catch { end(unavailable()); return; }
          try { onLine(value); } catch (error) { end(error); return; }
        }
        if (pending.length > maxLineBytes) end(unavailable());
      });
      res.on('end', () => end(unavailable())); res.on('aborted', () => end(unavailable())); res.on('error', () => end(unavailable()));
    });
    req.on('error', () => end(unavailable()));
    arm(); req.end();
    return { close: () => end(null) };
  }

  return {
    resolve, exchange, stream,
    // Drops the cached record if it is still the one the failed call used.
    invalidate(target) { if (target === undefined || record === target) record = null; },
  };
}
