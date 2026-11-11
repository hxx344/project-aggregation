import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveWarmup } from '../../server/runtime/data-plane.mjs';
import { registerModuleTransport } from '../../server/modules/transport.mjs';
import { moduleIds } from '../../server/modules/catalog.mjs';
import { moduleCapabilities } from '../../server/modules/capabilities.mjs';

// Stands in for startModules() in the two-process tests: one HTTP server per
// module on a socket in `socketDir`. Each module answers with its id and this
// process's pid, and counts the maintenance values it was sent, also readable
// through GET /maintenance-calls. `failMaintenance[id]` maintenance calls of
// that module answer 503 first (Infinity: all of them). `hold(id)` keeps that
// module's maintenance replies until the returned release() is called.
export function fakeModules(socketDir, { failMaintenance = {} } = {}) {
  const maintenanceCalls = Object.fromEntries(moduleIds.map(id => [id, 0])), holds = {};
  function hold(id) { let release; holds[id] = new Promise(resolve => { release = resolve; }); return () => { delete holds[id]; release(); }; }
  async function startModules({ onStarting }) {
    const servers = [], removers = [];
    const close = async () => { for (const remove of removers.splice(0)) remove(); await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))); };
    onStarting({ close });
    for (const id of moduleIds) {
      const secret = randomBytes(32).toString('hex'), socketPath = path.join(socketDir, `${id}-${process.pid}-${randomBytes(3).toString('hex')}.sock`);
      const server = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        if (req.url === '/__workspace/maintenance') {
          maintenanceCalls[id] += 1;
          await holds[id];
          if (maintenanceCalls[id] <= (failMaintenance[id] ?? 0)) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unavailable' })); return; }
        }
        const value = req.url === '/__workspace/maintenance' ? { active: body.active } : req.url === '/maintenance-calls' ? { calls: maintenanceCalls[id] }
          : req.url === '/__workspace/capabilities' ? moduleCapabilities(id) : req.url === '/__workspace/update-status' ? { busy: false } : { ok: true, module: id, pid: process.pid };
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
      });
      await new Promise(resolve => server.listen(socketPath, resolve)); servers.push(server);
      removers.push(registerModuleTransport(id, { socketPath, secret }));
    }
    const status = () => moduleIds.map(moduleId => ({ moduleId, state: 'ready', generation: 1, restartCount: 0, consecutiveFailures: 0, lastExitAt: null, lastExitKind: null,
      readyAt: null, nextAttemptAt: null, waitingFor: null, faultReason: null }));
    return { status, restart: () => false, markStarted() {}, close };
  }
  return { startModules, maintenanceCalls, hold };
}
// Without background refreshes, so a test sees only the calls it makes.
export const dataPlaneOptions = { refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, warmup: resolveWarmup({ warmupEnabled: false }) };
