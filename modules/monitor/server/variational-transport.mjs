import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://omni.variational.io';
const HELPER = fileURLToPath(new URL('./variational-request.py', import.meta.url));
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const PATHS = new Map([
  ['/api/me', 'GET'],
  ['/api/quotes/indicative', 'POST'],
  ['/api/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future', 'GET'],
  ['/api/funding/v2?underlying=CL&instrument_type=perpetual_rwa_future', 'GET'],
]);
const HEADER_NAMES = new Set(['accept', 'user-agent', 'cache-control', 'referer', 'content-type', 'cookie']);
const RESPONSE_HEADERS = new Set(['content-type', 'x-omni-auth', 'cf-mitigated']);
const MAX_BODY_BYTES = 2_000_000, MAX_STDOUT_BYTES = 3_000_000, MAX_STDERR_BYTES = 16_384;
const fail = (message = 'Variational 标准行情传输暂不可用，请稍后重试。', code = 'VARIATIONAL_TRANSPORT_FAILURE', name = 'Error') => Object.assign(new Error(message), { code, name });
const invalid = () => fail('不支持的 Variational 数据请求。', 'VARIATIONAL_REQUEST_INVALID');
const abortError = () => fail('Variational 数据请求已取消。', 'VARIATIONAL_ABORTED', 'AbortError');
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, names) => plainObject(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const jwtCookie = value => typeof value === 'string' && value.length <= 8201 && /^vr-token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);

function requestPayload(input, init) {
  try {
    if (typeof input !== 'string' && !(input instanceof URL)) throw invalid();
    const url = new URL(input), path = url.pathname + url.search, method = PATHS.get(path);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || !method || (init.method !== undefined && String(init.method).toUpperCase() !== method)) throw invalid();
    if (init.redirect !== undefined && init.redirect !== 'error') throw invalid();
    const incoming = new Headers(init.headers);
    for (const [name, value] of incoming) {
      if (!HEADER_NAMES.has(name) || !/^[\x20-\x7e]*$/.test(value) || value.length > (name === 'cookie' ? 8201 : 1024)) throw invalid();
    }
    for (const [name, expected] of [['accept', 'application/json'], ['content-type', 'application/json'], ['cache-control', 'no-cache'], ['referer', `${ORIGIN}/`]]) {
      if (incoming.has(name) && incoming.get(name) !== expected) throw invalid();
    }
    const cookie = incoming.get('cookie');
    const authenticated = path === '/api/me' || path === '/api/quotes/indicative';
    if (authenticated ? !jwtCookie(cookie) : cookie !== null) throw invalid();
    const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache', Referer: `${ORIGIN}/` };
    if (cookie !== null) headers.Cookie = cookie;
    let body = null;
    if (method === 'POST') {
      if (typeof init.body !== 'string' || Buffer.byteLength(init.body) > 16_384) throw invalid();
      const submitted = JSON.parse(init.body), definition = submitted?.instrument;
      if (!sameKeys(submitted, ['instrument', 'qty']) || submitted.qty !== '1' || !sameKeys(definition, ['underlying', 'instrument_type', 'settlement_asset', 'kind']) || !['BZ', 'CL'].includes(definition.underlying) || definition.instrument_type !== 'perpetual_rwa_future' || definition.settlement_asset !== 'USDC' || definition.kind !== 'commodity') throw invalid();
      body = { instrument: { underlying: definition.underlying, instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind: 'commodity' }, qty: '1' };
      headers['Content-Type'] = 'application/json';
    } else if (init.body !== undefined && init.body !== null) throw invalid();
    return JSON.stringify({ url: `${ORIGIN}${path}`, method, headers, body });
  } catch { throw invalid(); }
}

function responseFromOutput(output) {
  try {
    const value = JSON.parse(output);
    if (!sameKeys(value, ['status', 'headers', 'body']) || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 || !plainObject(value.headers) || typeof value.body !== 'string' || value.body.length > Math.ceil(MAX_BODY_BYTES / 3) * 4) throw fail();
    const headers = {};
    for (const [name, item] of Object.entries(value.headers)) {
      if (!RESPONSE_HEADERS.has(name) || typeof item !== 'string' || item.length > 1024 || !/^[\x20-\x7e]*$/.test(item)) throw fail();
      headers[name] = item;
    }
    const body = Buffer.from(value.body, 'base64');
    if (body.length > MAX_BODY_BYTES || body.toString('base64') !== value.body) throw fail();
    return new Response(body.length ? body : null, { status: value.status, headers });
  } catch { throw fail(); }
}

/** Native server transport. Only stdlib Python is used; input credentials stay on stdin.
 * Injection is for offline process tests; production uses the fixed runtime and helper.
 */
export function createVariationalFetch({ spawnImpl = spawn, platform = process.platform, timeoutMs = 10_000 } = {}) {
  const command = platform === 'win32' ? 'python' : 'python3';
  const duration = Number.isFinite(timeoutMs) ? Math.min(10_000, Math.max(1, timeoutMs)) : 10_000;
  return async function fetchVariational(input, init = {}) {
    const payload = requestPayload(input, init), signal = init.signal;
    if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) throw invalid();
    if (signal?.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      let child, timer, settled = false, stdoutSize = 0, stderrSize = 0;
      const chunks = [];
      const finish = (error, response, kill = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (kill) { try { child?.kill('SIGKILL'); } catch { /* Error details may contain caller input. */ } }
        child?.stdin?.destroy();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        if (error) reject(error); else resolve(response);
      };
      const onAbort = () => finish(abortError(), undefined, true);
      const processError = error => finish(error?.code === 'ENOENT'
        ? fail('Variational 行情传输需要 Python 3，当前服务未找到运行环境；请重新运行一键部署或安装 Python 3。', 'VARIATIONAL_PYTHON_MISSING')
        : fail(), undefined, true);
      try {
        child = spawnImpl(command, ['-I', HELPER], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.once('error', processError);
        child.stdin.on('error', () => finish(fail(), undefined, true));
        child.stdout.on('error', () => finish(fail(), undefined, true));
        child.stderr.on('error', () => finish(fail(), undefined, true));
        child.stdout.on('data', chunk => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          stdoutSize += buffer.length;
          if (stdoutSize > MAX_STDOUT_BYTES) { finish(fail(), undefined, true); return; }
          chunks.push(buffer);
        });
        child.stderr.on('data', chunk => {
          if (settled) return;
          stderrSize += Buffer.byteLength(chunk);
          if (stderrSize > MAX_STDERR_BYTES) finish(fail(), undefined, true);
        });
        child.once('close', code => {
          if (settled) return;
          if (code !== 0) { finish(fail()); return; }
          try { finish(undefined, responseFromOutput(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(fail()); }
        });
        timer = setTimeout(() => finish(fail('Variational 数据请求超时，请稍后重试。', 'VARIATIONAL_TIMEOUT', 'TimeoutError'), undefined, true), duration);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        child.stdin.end(payload);
      } catch (error) { processError(error); }
    });
  };
}

export const fetchVariational = createVariationalFetch();
