import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { logger as defaultLogger } from '../logger.mjs';
import { runProcess } from '../process-entry.mjs';
import { HttpError, send } from '../http-common.mjs';
import { SLOT_PROTOCOL, SLOTS, assertPrivateDirectory, controlRequest, encodeProxyHeader, entrySockets, listenPrivate, readSlotRecord, slotDirectory, slotSockets } from '../slot-protocol.mjs';

// A connection whose slot is not there yet (restarting, not promoted) waits:
// one attempt every retryMs, each at most connectTimeoutMs, budgetMs in all
// (design doc api-dual-slot 3.7). Nothing has been forwarded before it
// connects, so every attempt is safe to repeat.
export const ENTRY_RETRY_MS = 200;
export const ENTRY_CONNECT_TIMEOUT_MS = 2000;
export const ENTRY_BUDGET_MS = 10_000;
// On stop the slots have drained already (they stop before the entry); what is
// left gets this long before it is cut.
export const ENTRY_CLOSE_GRACE_MS = 5000;
// A client that takes nothing of what its slot sent for this long (a dead
// peer, a zero window) loses the connection, so the slot's side is released.
export const ENTRY_STALL_MS = 30_000;
// Repeated warnings (no record, a slot that stays away) are logged once per window.
const WARN_WINDOW_MS = 5000;
const CONTROL_BODY_MAX = 4096;

// The entry unit's settings (design doc 3.2): the public HOST and PORT the API
// used to listen on, its own socket directory, the installer's `.api-slot`
// record, and the root holding the slots' runtime directories.
export function entryOptions(env) {
  if (process.platform === 'win32') throw new Error('稳定入口只用于 Linux systemd 部署');
  const port = Number(env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535');
  const { WORKBENCH_ENTRY_DIR: dir, WORKBENCH_API_SLOT_RECORD: record, WORKBENCH_ENTRY_SLOT_ROOT: slotRoot } = env;
  if (![dir, record, slotRoot].every(value => value && path.isAbsolute(value))) throw new Error('稳定入口需要绝对路径的 WORKBENCH_ENTRY_DIR、WORKBENCH_API_SLOT_RECORD 与 WORKBENCH_ENTRY_SLOT_ROOT');
  return { host: env.HOST || '127.0.0.1', port, dir, record, slotRoot };
}

function throttledWarning(logger) {
  const last = new Map();
  return (key, fields, message) => {
    const now = Date.now(), entry = last.get(key);
    if (entry && now - entry.at < WARN_WINDOW_MS) { entry.suppressed += 1; return; }
    logger.warn({ ...fields, suppressed: entry?.suppressed || 0, type: 'entry' }, message);
    last.set(key, { at: now, suppressed: 0 });
  };
}

// The stable entry (design doc api-dual-slot 3.1, 3.2, 3.7): it holds the
// public port and passes every TCP connection, byte for byte, to the serving
// slot's http.sock, after a PROXY v1 line with the client's addresses. It does
// not parse HTTP. The target slot comes from the record at start and changes
// only through POST /switch on its control socket, which re-checks the record
// and the slot's identity; a switch moves the connections accepted after it,
// the ones already forwarded stay with their slot until it drains them.
export async function startEntry({ host, port, dir, record, slotRoot, logger = defaultLogger, fail = () => {}, retryMs = ENTRY_RETRY_MS, connectTimeoutMs = ENTRY_CONNECT_TIMEOUT_MS, budgetMs = ENTRY_BUDGET_MS, closeGraceMs = ENTRY_CLOSE_GRACE_MS, stallMs = ENTRY_STALL_MS }) {
  const warn = throttledWarning(logger);
  const sockets = Object.fromEntries(SLOTS.map(slot => [slot, slotSockets(slotDirectory(slotRoot, slot))]));
  // forwarded: per slot, the pairs whose slot connection is open; waiting:
  // clients still looking for theirs; clients: every accepted client socket
  // until it closes, also one still writing out after its slot has gone.
  const forwarded = Object.fromEntries(SLOTS.map(slot => [slot, new Set()])), waiting = new Set(), clients = new Set();
  let target = readSlotRecord(record)?.slot ?? null, generation = 0, closing = null, switching = Promise.resolve();
  if (!target) logger.warn({ record, type: 'entry' }, '槽记录不存在或无效，入口暂不转发连接');

  // Without a target the record is read again for each connection: the
  // installer may write it after the entry started. It is never guessed.
  function currentTarget() {
    if (target) return target;
    try { target = readSlotRecord(record)?.slot ?? null; } catch (error) { warn('record', { err: error, record }, '槽记录无法读取，入口暂不转发连接'); return null; }
    if (target) logger.info({ slot: target, type: 'entry' }, '已读到槽记录，入口开始转发');
    else warn('record', { record }, '槽记录不存在或无效，连接已关闭');
    return target;
  }

  // A TCP client sees a slot's failure as a reset, so a response that ends
  // with its connection is not taken for complete.
  const reset = socket => { if (!socket.destroyed) socket.resetAndDestroy(); };

  function pipe(client, upstream, slot) {
    const pair = { client, upstream }, set = forwarded[slot];
    set.add(pair);
    upstream.once('close', () => set.delete(pair));
    upstream.on('error', () => {});
    let header;
    try { header = encodeProxyHeader({ remoteAddress: client.remoteAddress, remotePort: client.remotePort, localAddress: client.localAddress, localPort: client.localPort }); }
    catch { client.destroy(); upstream.destroy(); return; }
    // Closes that are not an orderly FIN pass on as a reset, either way.
    client.once('close', () => { if (!client.readableEnded) upstream.destroy(); });
    upstream.once('close', () => { if (!upstream.readableEnded) reset(client); });
    // The pipe pauses the slot's side while the client takes nothing.
    let stalled = null;
    upstream.on('pause', () => { clearTimeout(stalled); stalled = setTimeout(() => { reset(client); upstream.destroy(); }, stallMs); });
    upstream.on('resume', () => clearTimeout(stalled));
    upstream.once('close', () => clearTimeout(stalled));
    upstream.write(header);
    client.pipe(upstream); upstream.pipe(client);
    // The client's FIN leaves the slot free to answer (half-close). The slot's
    // FIN ends the connection, as it would from the API itself: the slot's
    // side closes at once, the client's once its last bytes are written, or
    // when it stops taking them.
    upstream.once('end', () => {
      client.unpipe(upstream); upstream.end();
      client.setTimeout(stallMs, () => reset(client));
      client.destroySoon();
    });
  }

  function forward(client) {
    client.on('error', () => {});
    clients.add(client);
    client.once('close', () => clients.delete(client));
    const accepted = Date.now();
    let pending = null, retry = null, timer = null;
    // A paused client's own close goes unnoticed until it is read: it waits
    // out the budget, or reaches its slot as a header and an end.
    const stop = ({ drop = false } = {}) => { clearTimeout(retry); clearTimeout(timer); pending?.destroy(); pending = null; waiting.delete(stop); if (drop) client.destroy(); };
    waiting.add(stop);
    client.once('close', () => stop());
    const attempt = () => {
      if (closing || client.destroyed) { stop(); return; }
      const slot = currentTarget();
      if (!slot) { stop({ drop: true }); return; }
      const upstream = pending = net.connect({ path: sockets[slot].http, allowHalfOpen: true });
      // The last attempt ends with the budget.
      timer = setTimeout(() => upstream.destroy(Object.assign(new Error('连接槽超时'), { code: 'ETIMEDOUT' })), Math.min(connectTimeoutMs, budgetMs - (Date.now() - accepted)));
      const failed = error => {
        clearTimeout(timer); pending = null;
        if (closing || client.destroyed) { stop(); return; }
        if (Date.now() - accepted + retryMs < budgetMs) { retry = setTimeout(attempt, retryMs); return; }
        warn(`budget-${slot}`, { slot, code: error.code }, '目标槽在重试预算内不可用，连接已关闭');
        stop({ drop: true });
      };
      upstream.once('error', failed);
      upstream.once('connect', () => {
        upstream.off('error', failed); pending = null; stop();
        if (closing || client.destroyed) { upstream.destroy(); return; }
        pipe(client, upstream, slot);
      });
    };
    attempt();
  }

  const status = () => ({ protocol: SLOT_PROTOCOL, pid: process.pid, target, generation,
    connections: Object.fromEntries(SLOTS.map(slot => [slot, forwarded[slot].size])), waiting: waiting.size });

  // Moves new connections to a slot only when the record names it and the
  // slot itself reports serving, from the record's release, as the instance
  // the installer verified. Switches run one at a time.
  async function switchTo(body) {
    if (closing) throw new HttpError(503, '入口正在关闭');
    const { slot, instanceId } = body && typeof body === 'object' ? body : {};
    if (!SLOTS.includes(slot) || typeof instanceId !== 'string' || !instanceId) throw new HttpError(400, '切换需要槽名与实例号');
    const recorded = readSlotRecord(record);
    if (recorded?.slot !== slot) throw new HttpError(409, '槽记录未指向目标槽');
    let reply;
    try { reply = await controlRequest(sockets[slot].ctl, 'GET', '/identity', { timeoutMs: connectTimeoutMs }); }
    catch (error) { throw new HttpError(503, `无法读取目标槽身份：${error.message}`); }
    if (reply.status !== 200) throw new HttpError(503, `目标槽身份接口返回 ${reply.status}`);
    const identity = reply.data;
    let release = null; try { release = realpathSync(recorded.release); } catch {}
    if (identity?.protocol !== SLOT_PROTOCOL || identity.slot !== slot || identity.mode !== 'serving' || identity.instanceId !== instanceId || identity.release !== release)
      throw new HttpError(409, '目标槽的身份与记录或预期实例不一致');
    if (target !== slot) {
      const from = target; target = slot; generation += 1;
      logger.info({ from, to: slot, instanceId, generation, type: 'entry' }, '入口已切换目标槽');
    }
    return { target, generation };
  }

  // Read at once, outside the queue of switches: a request that goes away
  // while it waits must not hold up the ones after it.
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', chunk => { size += chunk.length; if (size <= CONTROL_BODY_MAX) chunks.push(chunk); });
      req.on('error', reject);
      req.on('close', () => { if (!req.complete) reject(new Error('请求已中断')); });
      req.on('end', () => {
        if (size > CONTROL_BODY_MAX) { reject(new HttpError(413, '请求体过大')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new HttpError(400, '请求体不是 JSON')); }
      });
    });
  }
  const ctl = http.createServer((req, res) => {
    const route = `${req.method} ${req.url}`;
    if (route === 'GET /status') { send(res, 200, status()); return; }
    if (route === 'POST /switch') {
      // The queue never rejects; a body that never arrived fails this request only.
      const body = readBody(req); body.catch(() => {});
      const result = switching.then(() => body).then(switchTo);
      switching = result.catch(() => {});
      result.then(value => send(res, 200, value), error => send(res, error.status || 500, { error: error.message }));
      return;
    }
    send(res, 404, { error: '控制接口不存在' });
  });
  ctl.requestTimeout = 10_000;

  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, forward);
  async function close() {
    return closing ??= (async () => {
      const listening = [server, ctl].filter(item => item.listening).map(item => new Promise(resolve => item.close(() => resolve())));
      // A waiting client was never forwarded: closing it loses nothing.
      for (const stop of [...waiting]) stop({ drop: true });
      const deadline = Date.now() + closeGraceMs;
      while (clients.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (clients.size) logger.warn({ connections: clients.size, type: 'shutdown' }, '入口关闭时仍有转发中的连接，已强制断开');
      for (const client of clients) reset(client);
      for (const { upstream } of SLOTS.flatMap(slot => [...forwarded[slot]])) upstream.destroy();
      ctl.closeAllConnections();
      await Promise.all(listening);
    })();
  }
  try {
    assertPrivateDirectory(dir);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
    server.on('error', fail);
    await listenPrivate(ctl, entrySockets(dir).ctl);
    ctl.on('error', fail);
    return { ready: { port: server.address().port, target }, close, status };
  } catch (error) {
    await close();
    throw error;
  }
}

if (import.meta.main) {
  const options = entryOptions(process.env);
  void runProcess({ name: '入口', logger: defaultLogger, start: ({ fail }) => startEntry({ ...options, fail }) });
}
