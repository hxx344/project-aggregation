import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runProcess } from '../../server/process-entry.mjs';
import { startRuntime } from '../../server/runtime/main.mjs';
import { registerModuleTransport } from '../../server/modules/transport.mjs';
import { moduleIds } from '../../server/modules/catalog.mjs';
import { moduleCapabilities } from '../../server/modules/capabilities.mjs';
import { dataPlaneOptions } from './split-modules.mjs';

// Real runtime process and private HTTP module transports. Only the exchange
// modules are fixtures: their first CrossEx stop check returns busy after IPC
// release; a later check succeeds with fresh evidence. No external requests.
let releaseEvidence;
const heldEvidence = new Promise(resolve => { releaseEvidence = resolve; });
process.on('message', message => { if (message?.type === 'release-evidence') releaseEvidence(); });
async function startModules({ onStarting }) {
  const servers = [], removers = [], active = new Map();
  let holdFirstEvidence = true;
  const close = async () => {
    releaseEvidence();
    for (const remove of removers.splice(0)) remove();
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  };
  onStarting({ close });
  for (const id of moduleIds) {
    const socketPath = path.join(process.env.MODULE_SOCKET_DIR, `${id}.sock`);
    active.set(id, true);
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      let value;
      if (req.url === '/__workspace/maintenance') { active.set(id, body.active); value = { active: body.active }; }
      else if (req.url === '/__workspace/capabilities') value = moduleCapabilities(id);
      else if (req.url === '/__workspace/update-status') {
        const held = id === 'crossex' && holdFirstEvidence;
        if (held) { holdFirstEvidence = false; process.send({ type: 'evidence-held' }); await heldEvidence; }
        value = { busy: held };
      } else if (req.url === '/maintenance-state') value = { active: active.get(id) };
      else value = { ok: true, module: id, pid: process.pid };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
    });
    await new Promise(resolve => server.listen(socketPath, resolve)); servers.push(server);
    removers.push(registerModuleTransport(id, { socketPath, secret: randomBytes(32).toString('hex') }));
  }
  const status = () => moduleIds.map(moduleId => ({ moduleId, state: 'ready', generation: 1, restartCount: 0, consecutiveFailures: 0,
    lastExitAt: null, lastExitKind: null, readyAt: null, nextAttemptAt: null, waitingFor: null, faultReason: null }));
  return { status, restart: () => false, markStarted() {}, close };
}
const write = level => (fields, message) => process.stderr.write(JSON.stringify({ level, message, error: fields?.err?.message }) + '\n');
const logger = { info() {}, debug() {}, warn: write('warn'), error: write('error') };
void runProcess({ name: 'sharing-runtime', logger, start: options => startRuntime({ ...options, dataDir: process.env.DATA_DIR, logger, startModules, dataPlaneOptions }) });
