// Linux browser fixture of the split workbench as the service units run it:
// the real runtime (fake modules of split-modules.mjs) and the real API with
// the built Hub frontend as two independent processes, each started again 1 s
// after it exits (Restart=, RestartSec=1). Build the Hub first, then run from
// the repository root:
//   node tests/fixtures/split-browser.mjs
// Hub: http://hub.localhost:39154 (password split-browser-fixture-password)
// Control, 127.0.0.1:39155 only, for tests/split-reconnect.browser.mjs:
//   GET  /state                  pid, starts and readiness of each process
//   POST /kill/<api|runtime>     SIGKILL; ?hold=1 keeps it stopped until /start
//   POST /start/<api|runtime>    starts a held process again
//   POST /order/<module>?value=n changes that module's display order through
//                                the API with its own session (an overview event)
import http from 'node:http';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') throw new Error('The split browser fixture runs the POSIX process model only');
const root = fileURLToPath(new URL('../..', import.meta.url));
if (!existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('Build the Hub first (pnpm run build:bundle)');
const port = 39154, controlPort = 39155, password = 'split-browser-fixture-password';
// Short, so the runtime socket stays under the 100-byte socket path limit.
const dataDir = mkdtempSync('/tmp/split-browser-');
mkdirSync(path.join(dataDir, 'modules'), { mode: 0o700 });
// Also when startup fails; the children end on their own once the IPC channel closes.
process.once('exit', () => rmSync(dataDir, { recursive: true, force: true }));
const { WORKBENCH_RUNTIME_DIR: _ignored, ...inherited } = process.env;
const env = { ...inherited, DATA_DIR: dataDir, INITIAL_PASSWORD: password, MODULE_SOCKET_DIR: path.join(dataDir, 'modules'),
  SPLIT_API_PORT: String(port), SPLIT_DIST_DIR: path.join(root, 'dist'), COOKIE_SECURE: 'false', PUBLIC_ORIGIN: '', NODE_ENV: 'test' };

let stopping = false;
const units = Object.fromEntries(['runtime', 'api'].map(name => [name, { name, child: null, pid: null, starts: 0, ready: false, held: false, timer: null, exited: Promise.resolve() }]));
function start(unit) {
  clearTimeout(unit.timer); unit.timer = null;
  if (stopping || unit.child) return;
  const child = fork(fileURLToPath(new URL(`./split-${unit.name}.mjs`, import.meta.url)), [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  Object.assign(unit, { child, pid: child.pid, ready: false, starts: unit.starts + 1 });
  child.on('message', message => { if (message?.type === 'ready') unit.ready = true; });
  unit.exited = new Promise(resolve => child.once('exit', (code, signal) => {
    Object.assign(unit, { child: null, ready: false });
    process.stderr.write(`[split fixture] ${unit.name} ${unit.pid} exited (${signal || code})\n`);
    if (!stopping && !unit.held) unit.timer = setTimeout(() => start(unit), 1000);
    resolve();
  }));
}
// The API refuses to start before the runtime has created the data directory.
start(units.runtime);
await new Promise((resolve, reject) => {
  const check = setInterval(() => {
    if (units.runtime.ready) { clearInterval(check); resolve(); }
    else if (units.runtime.starts > 3) { clearInterval(check); reject(new Error('runtime did not start after 3 attempts')); }
  }, 50);
});
start(units.api);

// One request to the API as a separate session; the browser keeps its own.
function apiRequest(route, { method = 'GET', body, cookie, csrf } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body), host = `hub.localhost:${port}`;
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, agent: false, timeout: 10_000,
      headers: { Host: host, Origin: `http://${host}`, ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...(encoded ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { let data = null; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, data }); });
    });
    req.on('timeout', () => req.destroy(new Error('fixture API request timed out'))); req.on('error', reject); req.end(encoded);
  });
}
async function changeOrder(id, value) {
  const login = await apiRequest('/api/login', { method: 'POST', body: { password } });
  if (login.status !== 200) return login;
  const cookie = login.headers['set-cookie'][0].split(';')[0], csrf = login.data.csrfToken;
  try { return await apiRequest(`/api/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: { order: value }, cookie, csrf }); }
  finally { await apiRequest('/api/logout', { method: 'POST', cookie, csrf }).catch(() => {}); }
}

const control = http.createServer(async (req, res) => {
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url, 'http://control.invalid'), [, action, name] = url.pathname.split('/');
    const state = () => Object.fromEntries(Object.values(units).map(({ name: id, pid, starts, ready, held }) => [id, { pid, starts, ready, held, running: !!units[id].child }]));
    if (req.method === 'GET' && url.pathname === '/state') return send(200, state());
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    if (action === 'order') {
      const value = Number(url.searchParams.get('value'));
      const result = await changeOrder(name, value);
      return send(result.status === 200 ? 200 : 502, { status: result.status, error: result.data?.error });
    }
    const unit = units[name];
    if (!unit) return send(404, { error: 'unknown process' });
    if (action === 'kill') {
      unit.held = url.searchParams.get('hold') === '1';
      if (unit.child) { unit.child.kill('SIGKILL'); await unit.exited; }
      return send(200, state());
    }
    if (action === 'start') { unit.held = false; start(unit); return send(200, state()); }
    return send(404, { error: 'unknown action' });
  } catch (error) { send(500, { error: error.message }); }
});
await new Promise((resolve, reject) => { control.once('error', reject); control.listen(controlPort, '127.0.0.1', resolve); });
console.log(`Split browser fixture: http://hub.localhost:${port} (password ${password}); control http://127.0.0.1:${controlPort}`);

async function shutdown() {
  if (stopping) return;
  stopping = true; control.close();
  // The API first, as the launcher and the units' PartOf= order it.
  for (const unit of [units.api, units.runtime]) {
    clearTimeout(unit.timer);
    if (!unit.child) continue;
    const timer = setTimeout(() => unit.child?.kill('SIGKILL'), 20_000);
    unit.child.kill('SIGTERM'); await unit.exited; clearTimeout(timer);
  }
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown(); });
