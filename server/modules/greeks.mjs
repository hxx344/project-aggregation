import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridge = fileURLToPath(new URL('./greeks-bridge.py', import.meta.url));
const workspace = resolve(dirname(bridge), '../..');
const MAX_BODY = 1024 * 1024;
const MAX_LINE = 24 * 1024 * 1024;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-workspace-key']);

export function pythonExecutable(environment = {}) {
  const managed = resolve(workspace, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return environment.GREEKS_PYTHON || process.env.GREEKS_PYTHON || (existsSync(managed) ? managed : process.platform === 'win32' ? 'python' : 'python3');
}

export async function createModule(options) {
  return createGreeksModule(options);
}

// Explicit fixture hooks are used only by transport tests, never by HTTP input.
export async function createGreeksModule({ root, dataDir, secret, environment = {}, application = 'app.main:app', requestTimeout = 60_000, startupTimeout = 90_000 }) {
  if (typeof secret !== 'string' || secret.length < 12) throw new Error('Missing Greeks worker secret');
  mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, ...environment, STATE_FILE: resolve(dataDir, 'engine_state.json'),
    DASHBOARD_USERNAME: 'workspace', DASHBOARD_PASSWORD: secret, WORKSPACE_MANAGED: '1',
    PYTHONPATH: root, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  const child = spawn(pythonExecutable(environment), ['-u', bridge, application], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let counter = 0, buffer = '', closing = false, ready = false, failed = false;
  let resolveReady, rejectReady;
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise(resolve => child.once('close', resolve));
  const server = createServer(async (request, response) => {
    if (request.headers['x-workspace-key'] !== secret) { response.writeHead(403).end('Forbidden'); return; }
    if (!ready || failed || closing) { response.writeHead(503).end('Greeks unavailable'); return; }
    if (pending.size >= 64 || child.stdin.writableLength > 4 * MAX_BODY) { response.writeHead(503).end('Greeks busy'); return; }
    let id;
    const cancel = () => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id); clearTimeout(entry.timer);
      write({ type: 'cancel', id });
    };
    response.once('close', cancel);
    try {
      if (Number(request.headers['content-length']) > MAX_BODY) { response.writeHead(413).end('Request too large'); return; }
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) { response.writeHead(413).end('Request too large'); return; }
        chunks.push(chunk);
      }
      if (response.destroyed || failed || closing) return;
      id = ++counter;
      const headers = Object.entries(request.headers).filter(([name]) => !HOP_HEADERS.has(name) && name !== 'authorization')
        .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).filter(value => value != null).map(value => [name, value]));
      headers.push(['authorization', `Basic ${Buffer.from(`workspace:${secret}`).toString('base64')}`]);
      const timer = setTimeout(() => { cancel(); if (!response.destroyed) response.writeHead(504).end('Greeks request timed out'); }, requestTimeout);
      pending.set(id, { response, timer });
      write({ type: 'request', id, method: request.method, url: request.url,
        scheme: request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http', headers, body: Buffer.concat(chunks).toString('base64') });
    } catch {
      cancel();
      if (!response.destroyed && !response.headersSent) response.writeHead(502).end('Greeks request failed');
    }
  });
  server.requestTimeout = 30_000;

  function write(message) {
    if (!failed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n');
  }
  function fail() {
    if (failed) return;
    failed = true; ready = false;
    rejectReady(new Error('Greeks bridge unavailable'));
    for (const { response, timer } of pending.values()) {
      clearTimeout(timer);
      if (!response.destroyed) response.writeHead(503).end('Greeks unavailable');
    }
    pending.clear();
    child.kill();
    if (!closing && server.listening) server.emit('error', new Error('Greeks bridge exited'));
  }
  child.once('error', fail);
  child.once('exit', () => { if (!closing) fail(); });
  child.stdin.on('error', () => { if (!closing) fail(); });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_LINE) { fail(); return; }
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === 'ready' && !ready && !failed) { ready = true; resolveReady(); continue; }
        if (message.type === 'closed' && closing) continue;
        if (!['response', 'error'].includes(message.type)) throw new Error('Invalid bridge message');
        const entry = pending.get(message.id);
        if (!entry) continue;
        if (entry.response.destroyed) { pending.delete(message.id); clearTimeout(entry.timer); continue; }
        if (message.type === 'error') { pending.delete(message.id); clearTimeout(entry.timer); entry.response.writeHead(502).end('Greeks request failed'); continue; }
        if (!Number.isInteger(message.status) || message.status < 200 || message.status > 599 || !Array.isArray(message.headers) || typeof message.body !== 'string') throw new Error('Invalid ASGI response');
        const headers = {};
        for (const [name, value] of message.headers) {
          if (HOP_HEADERS.has(name.toLowerCase())) continue;
          if (headers[name] === undefined) headers[name] = value;
          else headers[name] = [].concat(headers[name], value);
        }
        entry.response.writeHead(message.status, headers).end(Buffer.from(message.body, 'base64'));
        pending.delete(message.id); clearTimeout(entry.timer);
      } catch { fail(); return; }
    }
  });
  const timer = setTimeout(fail, startupTimeout);
  try { await started; } catch (error) { closing = true; child.kill(); throw error; } finally { clearTimeout(timer); }
  let closePromise;
  return { server, child, close() {
    return closePromise ??= (async () => {
      closing = true; ready = false;
      for (const { response, timer } of pending.values()) { clearTimeout(timer); if (!response.destroyed) response.writeHead(503).end('Greeks shutting down'); }
      pending.clear();
      write({ type: 'shutdown' }); child.stdin.end();
      const kill = setTimeout(() => child.kill(), 10_000);
      try { await exited; } finally { clearTimeout(kill); }
    })();
  } };
}
