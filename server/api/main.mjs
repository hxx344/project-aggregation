import { chmodSync, existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger as defaultLogger } from '../logger.mjs';
import { runProcess } from '../process-entry.mjs';
import { validateAuthOrigin } from '../adapters.mjs';
import { assertRecoveryStartup } from '../recovery/startup.mjs';
import { acquireLifecycleLock } from '../recovery/lifecycle-lock.mjs';
import { openHubDatabase, seedComplete, seedProjects } from '../control/schema.mjs';
import { logWriteWaits } from '../sqlite-writes.mjs';
import { createControlStore } from '../control/store.mjs';
import { createProjectCatalog } from '../control/projects.mjs';
import { ensurePassword } from '../control/password.mjs';
import { createExecutionJobsReader } from '../control/execution-jobs.mjs';
import { createRuntimeConnection } from '../runtime/connection.mjs';
import { createSocketClient } from '../runtime/supervisor-client.mjs';
import { createSocketDataClient } from '../runtime/data-client.mjs';
import { runtimeDir } from '../runtime/protocol.mjs';
import { SLOT_PROTOCOL, SLOTS, acceptProxyHeader, readSlotRecord, recordNames, slotSockets } from '../slot-protocol.mjs';
import { HttpError, send } from '../http-common.mjs';
import { createApiServer, resolveLoginLimits, supervisorTransports } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Only the legacy external projects store credentials, and this entry runs the
// embedded modules only; the key stays with the runtime.
const noCredentials = () => { throw new Error('API 进程不处理项目凭据'); };

// A slot of the dual-slot units (design doc api-dual-slot 3.2): its name, the
// directory of its private sockets and the installer's `.api-slot` record, all
// set by the unit or none. Without them the API listens on TCP as before.
export function slotOptions(env, release = realpathSync(root)) {
  if (!env.WORKBENCH_API_SLOT) return null;
  if (process.platform === 'win32') throw new Error('API 槽只用于 Linux systemd 部署');
  const { WORKBENCH_API_SLOT: slot, WORKBENCH_API_SLOT_DIR: dir, WORKBENCH_API_SLOT_RECORD: record } = env;
  if (!SLOTS.includes(slot)) throw new Error('WORKBENCH_API_SLOT 必须为 a 或 b');
  if (!dir || !path.isAbsolute(dir) || !record || !path.isAbsolute(record)) throw new Error('API 槽需要绝对路径的 WORKBENCH_API_SLOT_DIR 与 WORKBENCH_API_SLOT_RECORD');
  return { slot, dir, record, release };
}

// The slot's socket directory is the unit's RuntimeDirectory: this user's and
// closed to everyone else, which is what keeps the private sockets private.
function assertPrivateDirectory(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error(`API 槽目录须为本用户所有且权限为 0700：${dir}`);
}
// Removes a socket a killed process left; one that still answers is in use,
// and anything that is not a socket stays and makes listen() fail.
async function removeStale(file) {
  try { if (!lstatSync(file).isSocket()) return; } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const live = await new Promise(resolve => {
    const socket = net.connect(file);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => resolve(error.code === 'ENOENT' ? null : error.code !== 'ECONNREFUSED'));
  });
  if (live) throw Object.assign(new Error(`API 槽 socket 正被另一个进程使用：${file}`), { code: 'EADDRINUSE' });
  if (live === false) try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function listenPrivate(server, file) {
  await removeStale(file);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, () => { server.off('error', reject); resolve(); }); });
  chmodSync(file, 0o600);
}
const closeListener = server => server.listening ? new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); }) : null;

// The API process (design doc 3.1): sessions, the update coordinator, project
// configuration, Portal, the overview streams and static files, reaching the
// runtime only through its socket. It writes the control tables, so it seeds
// them. It holds `.api.lock` shared from before the recovery check until close()
// has closed the Hub database, so the recovery tools see it alive (design doc 5.7).
//
// A slot starts serving when the record names it and its release directory,
// otherwise as a candidate (design doc api-dual-slot 3.3): the database is
// query-only, nothing is created or seeded, and only probe.sock and ctl.sock
// exist until POST /promote; serving adds http.sock, the entry's traffic.
export async function startApi({ dataDir, logger = defaultLogger, signal, fail = () => {}, env = process.env, port = 3100, host = '127.0.0.1', distDir = path.join(root, 'dist'), updatesClient, loginLimits = resolveLoginLimits(), slot = slotOptions(env) }) {
  const resolvedData = path.resolve(dataDir);
  const sockets = slot && slotSockets(slot.dir);
  let ctl = null, promoting = null;
  // Each step checks the lock too: a lost lock may already let a recovery tool in.
  const stopped = () => { lock.assertHeld(); if (signal?.aborted) throw new Error('API 启动已中止'); };
  let db = null, api = null, lock = null, closing = null;
  const stopWriteLog = logWriteWaits({ logger, role: 'api' });
  function close() {
    return closing ??= (async () => {
      const results = [];
      // The control socket stops first; api.close() then drains the probe and traffic sockets.
      for (const action of [() => closeListener(ctl ?? {}), () => api?.close(), stopWriteLog, () => db?.close(), () => lock?.close()]) { try { await action(); } catch (error) { results.push(error); } }
      if (results.length) throw new AggregateError(results, 'API 关闭失败');
    })();
  }
  try {
    // The runtime creates the data directory and the credential key first; a
    // database created here without the key would keep the runtime from starting.
    if (!existsSync(path.join(resolvedData, 'credentials.key'))) throw new Error('运行时尚未初始化数据目录，请先启动运行时');
    if (slot) assertPrivateDirectory(slot.dir);
    lock = await acquireLifecycleLock({ dataDir: resolvedData, name: 'api', mode: 'shared', onLost: fail });
    stopped();
    assertRecoveryStartup(resolvedData);
    lock.assertHeld();
    const serving = !slot || recordNames(readSlotRecord(slot.record), slot);
    db = openHubDatabase(path.join(resolvedData, 'hub.sqlite'), { create: serving });
    const control = createControlStore(db);
    if (serving) {
      await ensurePassword(control, { initialPassword: env.INITIAL_PASSWORD, log: logger });
      seedProjects(control, { embeddedModules: true });
    } else if (!control.getSetting('password') || !seedComplete(control, { embeddedModules: true })) throw new Error('候选实例：管理员密码或项目种子尚未初始化');
    stopped();
    const dir = runtimeDir(resolvedData, env);
    // A new runtime instance restarted every module in maintenance: take them all through the durable value again.
    // It has no stream counts yet either.
    const connection = createRuntimeConnection({ dir, onInstanceChange: () => { void api?.updates?.resynchronize(); api?.reportStats(); } });
    const supervisor = createSocketClient({ dir, connection });
    api = createApiServer({ control, catalog: createProjectCatalog({ control, embeddedModules: true }), encrypt: noCredentials, decrypt: noCredentials, embeddedModules: true, log: logger,
      supervisor, runtime: createSocketDataClient({ dir, connection, log: logger }), executionJobs: createExecutionJobsReader(db),
      candidate: !serving, privateProbe: !!slot, updatesClient, secureCookies: env.COOKIE_SECURE === 'true',
      configuredOrigin: env.PUBLIC_ORIGIN ? validateAuthOrigin(env.PUBLIC_ORIGIN) : '', distDir, loginLimits, resolveTransport: supervisorTransports(supervisor) });
    // A module in fault or backoff must not keep the API from starting: its
    // execution entry stays refused until it is confirmed, and the release
    // watcher keeps retrying it.
    const initialize = () => api.initialize().catch(error => logger.warn({ err: error, type: 'startup' }, '交易模块的维护状态尚未全部确认，相关写入暂被拒绝'));
    if (serving) await initialize();
    stopped();
    if (!slot) {
      await new Promise((resolve, reject) => { api.server.once('error', reject); api.server.listen(port, host, () => { api.server.off('error', reject); resolve(); }); });
      api.server.once('error', fail);
      stopped();
      return { ready: { port: api.server.address().port }, close, server: api.server };
    }
    // A candidate has no traffic socket; one left by a killed predecessor goes too.
    if (!serving) await removeStale(sockets.http);
    acceptProxyHeader(api.server, { onReject: reason => logger.warn({ reason, type: 'slot' }, '私有连接缺少有效的地址头，已断开') });
    await listenPrivate(api.server, sockets.probe);
    api.server.once('error', fail);
    // mode is serving only once http.sock exists: the entry switches on it.
    let mode = 'candidate', failed = null;
    const openTraffic = async () => {
      const traffic = net.createServer(); api.attach(traffic);
      await listenPrivate(traffic, sockets.http); traffic.once('error', fail);
      mode = 'serving';
    };
    const identity = () => ({ protocol: SLOT_PROTOCOL, slot: slot.slot, instanceId: api.instanceId, pid: process.pid, release: slot.release, mode });
    // Promotion re-reads the record: only the slot it names serves. A failure
    // after the database became writable ends the process; its restart serves.
    const promote = () => promoting ??= (async () => {
      if (closing) throw new HttpError(503, 'API 正在关闭');
      if (failed) throw new HttpError(503, `晋升已失败，进程正在退出：${failed.message}`);
      if (mode === 'serving') return;
      if (!recordNames(readSlotRecord(slot.record), slot)) throw new HttpError(409, '槽记录未指向本实例');
      try {
        db.exec('PRAGMA query_only=OFF');
        api.promote(); await initialize();
        if (closing) throw new HttpError(503, 'API 正在关闭');
        await openTraffic();
        logger.info({ slot: slot.slot, type: 'slot' }, 'API 槽已接管服务');
      } catch (error) { if (!closing) { failed = error; fail(error); } throw error; }
    })().finally(() => { promoting = null; });
    ctl = http.createServer((req, res) => {
      const route = `${req.method} ${req.url}`;
      if (route === 'GET /identity') { send(res, 200, identity()); return; }
      if (route === 'POST /promote') { promote().then(() => send(res, 200, identity()), error => send(res, error.status || 500, { error: error.message })); return; }
      send(res, 404, { error: '控制接口不存在' });
    });
    // A serving start has http.sock before the control socket answers anything.
    if (serving) await openTraffic();
    await listenPrivate(ctl, sockets.ctl); ctl.once('error', fail);
    stopped();
    return { ready: { slot: slot.slot, mode }, close, server: api.server };
  } catch (error) {
    try { await close(); } catch (cause) { logger.error({ err: cause, type: 'startup' }, 'API 启动失败后的清理未完成'); }
    throw error;
  }
}

if (import.meta.main) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '.data'));
  const port = Number(process.env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535');
  void runProcess({ name: 'API', logger: defaultLogger, start: options => startApi({ ...options, dataDir, port, host: process.env.HOST || '127.0.0.1' }) });
}
