import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { portalHost } from '../portal.mjs';
import { moduleIds } from '../modules/catalog.mjs';
import { SLOT_PROTOCOL, SLOTS, controlRequest, encodeProxyHeader, entrySockets, slotSockets } from '../slot-protocol.mjs';

const REQUEST_TIMEOUT_MS = 5000;

// One read-only request on a slot's probe.sock, opened with the PROXY line the
// entry would send for a local client on the public port.
function probeRequest(file, port, route, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', path: route, timeout: REQUEST_TIMEOUT_MS, headers: { Host: host, Connection: 'close' },
      createConnection: () => { const socket = net.connect(file); socket.write(encodeProxyHeader({ remoteAddress: '127.0.0.1', remotePort: 1, localAddress: '127.0.0.1', localPort: port })); return socket; } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })));
    req.on('error', reject); req.end();
  });
}
const json = body => { try { return JSON.parse(body.toString()); } catch { return null; } };

// The installer's directed checks of one slot before it takes traffic (design
// doc api-dual-slot 3.3): its identity on ctl.sock, then reads without a
// session on probe.sock with the canonical Host `hub.localhost:<PORT>` — health
// and readiness, this release's index.html and one asset it references,
// Portal's refusal of a project host without a grant, and no session. Nothing
// here writes or issues anything, and the public port is never asked.
// Returns every failure found; an empty list passes.
export async function probeSlot({ dir, slot, release, port, pid, mode = 'candidate', entryDir }) {
  const failures = [], sockets = slotSockets(dir), host = `hub.localhost:${port}`;
  const check = (condition, message) => { if (!condition) failures.push(message); return condition; };
  let expectedRelease = null;
  try { expectedRelease = realpathSync(release); } catch (error) { failures.push(`目标版本目录不可读：${error.message}`); }
  let identity = null;
  try {
    const reply = await controlRequest(sockets.ctl, 'GET', '/identity', { timeoutMs: REQUEST_TIMEOUT_MS });
    if (check(reply.status === 200, `identity 返回 ${reply.status}`)) identity = reply.data;
  } catch (error) { failures.push(`无法读取槽身份：${error.message}`); }
  if (identity) {
    check(identity.protocol === SLOT_PROTOCOL, `槽协议 ${identity.protocol} 与探针的 ${SLOT_PROTOCOL} 不一致`);
    check(identity.slot === slot, `槽名为 ${identity.slot}，预期 ${slot}`);
    check(identity.mode === mode, `槽模式为 ${identity.mode}，预期 ${mode}`);
    check(identity.release === expectedRelease, `槽版本为 ${identity.release}，预期 ${expectedRelease}`);
    if (pid !== undefined) check(identity.pid === pid, `槽进程为 ${identity.pid}，单元 MainPID 为 ${pid}`);
  }
  if (entryDir) {
    try {
      const { status, data } = await controlRequest(entrySockets(entryDir).ctl, 'GET', '/status', { timeoutMs: REQUEST_TIMEOUT_MS });
      check(status === 200 && data?.protocol === SLOT_PROTOCOL, `入口协议 ${data?.protocol} 与探针的 ${SLOT_PROTOCOL} 不一致`);
    } catch (error) { failures.push(`无法读取入口状态：${error.message}`); }
  }
  const get = async (route, requestHost = host) => {
    try { return await probeRequest(sockets.probe, port, route, requestHost); } catch (error) { failures.push(`GET ${route}（${requestHost}）失败：${error.message}`); return null; }
  };
  for (const route of ['/api/health', '/api/ready']) {
    const reply = await get(route);
    if (reply) check(reply.status === 200, `GET ${route} 返回 ${reply.status}`);
  }
  const page = await get('/');
  if (page && check(page.status === 200, `GET / 返回 ${page.status}`) && expectedRelease) {
    const dist = path.join(expectedRelease, 'dist');
    let index = null;
    try { index = readFileSync(path.join(dist, 'index.html')); } catch (error) { failures.push(`目标版本缺少 index.html：${error.message}`); }
    if (index && check(page.body.equals(index), 'GET / 返回的不是目标版本的 index.html')) {
      const asset = /(?:src|href)="(\/assets\/[A-Za-z0-9_.-]+)"/.exec(index.toString())?.[1];
      if (check(asset, 'index.html 未引用 assets/ 下的文件')) {
        const reply = await get(asset);
        if (reply && check(reply.status === 200, `GET ${asset} 返回 ${reply.status}`)) {
          try { check(reply.body.equals(readFileSync(path.join(dist, asset))), `GET ${asset} 的内容与目标版本不同`); } catch (error) { failures.push(`目标版本缺少 ${asset}：${error.message}`); }
        }
      }
    }
  }
  const project = await get('/', `${portalHost(moduleIds[0])}:${port}`);
  if (project) check(project.status === 401, `未授权的项目页面返回 ${project.status}，预期 401`);
  const session = await get('/api/session');
  if (session && check(session.status === 200, `GET /api/session 返回 ${session.status}`)) check(json(session.body)?.authenticated === false, '无会话请求未得到 authenticated: false');
  return { failures, identity };
}

// node server/entry/probe.mjs --dir <slot dir> --slot a|b --release <dir> --port <PORT>
//   [--pid <MainPID>] [--mode candidate|serving] [--entry-dir <entry dir>]
// Prints {ok, failures, instanceId} as JSON; exits 0 only when every check passed.
if (import.meta.main) {
  const { values } = parseArgs({ options: { dir: { type: 'string' }, slot: { type: 'string' }, release: { type: 'string' }, port: { type: 'string' }, pid: { type: 'string' }, mode: { type: 'string' }, 'entry-dir': { type: 'string' } } });
  const port = Number(values.port), pid = values.pid === undefined ? undefined : Number(values.pid);
  const usage = [];
  if (!values.dir || !path.isAbsolute(values.dir)) usage.push('--dir 须为绝对路径');
  if (!SLOTS.includes(values.slot)) usage.push('--slot 须为 a 或 b');
  if (!values.release) usage.push('缺少 --release');
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage.push('--port 须为 1 至 65535');
  if (pid !== undefined && !(Number.isInteger(pid) && pid > 0)) usage.push('--pid 须为正整数');
  if (values.mode !== undefined && !['candidate', 'serving'].includes(values.mode)) usage.push('--mode 须为 candidate 或 serving');
  const { failures, identity } = usage.length ? { failures: usage, identity: null }
    : await probeSlot({ dir: values.dir, slot: values.slot, release: values.release, port, pid, mode: values.mode, entryDir: values['entry-dir'] });
  process.stdout.write(`${JSON.stringify({ ok: !failures.length, failures, instanceId: identity?.instanceId ?? null })}\n`);
  process.exitCode = failures.length ? 1 : 0;
}
