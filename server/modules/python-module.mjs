import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const bridge = fileURLToPath(new URL('./greeks-bridge.py', import.meta.url));
const MAX_BODY = 1024 * 1024;
const MAX_LINE = 24 * 1024 * 1024;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-workspace-key']);

export async function createPythonModule({ root, secret, env, executable, application, label,
  privateHeaders, requestTimeout = 60_000, startupTimeout = 90_000, shutdownTimeout = 10_000, requireWriterProtection = false }) {
  const child = spawn(executable, ['-u', bridge, application, String(shutdownTimeout / 1000)], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // Windows has no process group to probe; the supervisor waits for this pid
  // before starting a successor.
  if (process.platform === 'win32' && child.pid) process.send?.({ type: 'child', pid: child.pid });
  const pending = new Map();
  let counter = 0, buffer = '', closing = false, ready = false, failed = false;
  let resolveReady, rejectReady;
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise(resolve => child.once('close', resolve));
  const server = createServer(async (request, response) => {
    if (request.headers['x-workspace-key'] !== secret) { response.writeHead(403).end('Forbidden'); return; }
    if (!ready || failed || closing) { response.writeHead(503).end(`${label} unavailable`); return; }
    if (pending.size >= 64 || child.stdin.writableLength > 4 * MAX_BODY) { response.writeHead(503).end(`${label} busy`); return; }
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
      headers.push(...privateHeaders);
      const timer = setTimeout(() => { cancel(); if (!response.destroyed) response.writeHead(504).end(`${label} request timed out`); }, requestTimeout);
      pending.set(id, { response, timer });
      write({ type: 'request', id, method: request.method, url: request.url,
        scheme: request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http', headers, body: Buffer.concat(chunks).toString('base64') });
    } catch {
      cancel();
      if (!response.destroyed && !response.headersSent) response.writeHead(502).end(`${label} request failed`);
    }
  });
  server.requestTimeout = 30_000;

  function write(message) {
    if (!failed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n');
  }
  function fail() {
    if (failed) return;
    failed = true; ready = false;
    rejectReady(new Error(`${label} bridge unavailable`));
    for (const { response, timer } of pending.values()) {
      clearTimeout(timer);
      if (!response.destroyed) response.writeHead(503).end(`${label} unavailable`);
    }
    pending.clear();
    child.stdin.end();
    const termination = setTimeout(() => child.kill(), shutdownTimeout);
    termination.unref();
    exited.then(() => clearTimeout(termination));
    if (!closing && server.listening) server.emit('error', new Error(`${label} bridge exited`));
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
        if (message.type === 'error') { pending.delete(message.id); clearTimeout(entry.timer); entry.response.writeHead(502).end(`${label} request failed`); continue; }
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
  if (requireWriterProtection) {
    try {
      await new Promise((resolve, reject) => {
        const id = ++counter;
        let status;
        const timer = setTimeout(() => { pending.delete(id); write({ type: 'cancel', id }); reject(new Error(`${label} account protection handshake timed out`)); }, 5000);
        const response = { destroyed: false, writeHead(value) { status = value; return this; }, end(body) {
          try {
            const value = JSON.parse(Buffer.from(body || '').toString('utf8'));
            if (status !== 200 || value.writerProtectionVersion !== 1 || value.recoveryProtectionVersion !== 1 || typeof value.ready !== 'boolean' || !Number.isInteger(value.registeredConnections) || value.registeredConnections < 0) throw new Error('Invalid writer status');
            resolve();
          } catch { reject(new Error(`${label} shared account protection is unavailable`)); }
        } };
        pending.set(id, { response, timer });
        write({ type: 'request', id, method: 'GET', url: '/__workspace/writer-status', scheme: 'http', headers: [['host', 'localhost'], ...privateHeaders], body: '' });
      });
    } catch (error) { closing = true; fail(); child.kill(); await exited; throw error; }
  }
  let closePromise;
  return { server, child, writerProtectionVersion: requireWriterProtection ? 1 : null, recoveryProtectionVersion: requireWriterProtection ? 1 : null, close() {
    return closePromise ??= (async () => {
      closing = true; ready = false;
      for (const { response, timer } of pending.values()) { clearTimeout(timer); if (!response.destroyed) response.writeHead(503).end(`${label} shutting down`); }
      pending.clear();
      write({ type: 'shutdown' }); child.stdin.end();
      const kill = setTimeout(() => child.kill(), shutdownTimeout);
      try { await exited; } finally { clearTimeout(kill); }
    })();
  } };
}
