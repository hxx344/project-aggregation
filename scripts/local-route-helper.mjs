import { execFile } from 'node:child_process';
import { createServer, request } from 'node:http';
import { isIP } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const SERVICE = 'project-aggregation-local-route';
export const ALLOWED_ORIGIN = 'http://hub.localhost:3100';
export const HELPER_HOST = '127.0.0.1:3101';
const SCRIPT = fileURLToPath(new URL('./inspect-ssh-route.ps1', import.meta.url));
const REASONS = new Set([
  'ssh-not-found', 'target-mismatch', 'multiple-connections', 'source-mismatch',
  'non-physical-interface', 'clash-unavailable', 'clash-tun-enabled', 'clash-proxy',
  'probe-failed', 'probe-timeout', 'probe-cancelled',
]);
const PIPE_PATTERN = /^(?:verge-mihomo-sidecar-[\w.-]+|mihomo)$/;

export function validateConfig({ server, sshPort = 22 }) {
  if (typeof server !== 'string' || !isIP(server) || server.includes('%')) {
    throw new Error('--server must be an IPv4 or IPv6 address without a zone identifier');
  }
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new Error('--ssh-port must be an integer between 1 and 65535');
  }
  return { server, sshPort };
}

function addressKey(address) {
  if (typeof address !== 'string' || !isIP(address) || address.includes('%')) return null;
  return isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.toLowerCase() : address;
}

function sameAddress(left, right) {
  const normalized = addressKey(left);
  return normalized !== null && normalized === addressKey(right);
}

function result(config, reason, now) {
  return {
    service: SERVICE, schema: 1, state: reason === 'verified-direct' ? 'direct' : 'unknown',
    reason, server: config.server, sshPort: config.sshPort, checkedAt: new Date(now).toISOString(),
  };
}

/** Only positive, mutually consistent observations can produce a direct result. */
export function classifyRoute(inspection, configuration, now = Date.now()) {
  const config = validateConfig(configuration);
  const unknown = reason => result(config, reason, now);
  if (!inspection || typeof inspection !== 'object') return unknown('probe-failed');
  if (inspection.reason) return unknown(REASONS.has(inspection.reason) ? inspection.reason : 'probe-failed');
  const { tunnel, route, clash } = inspection;
  if (!tunnel || tunnel.processName !== 'ssh.exe' || tunnel.listenerOwners !== 1) return unknown('ssh-not-found');
  if (tunnel.connectionCount !== 1) return unknown('multiple-connections');
  if (tunnel.state !== 'Established' || !sameAddress(tunnel.server, config.server) || tunnel.sshPort !== config.sshPort) {
    return unknown('target-mismatch');
  }
  if (!route || !sameAddress(tunnel.sourceAddress, route.sourceAddress)) return unknown('source-mismatch');
  if (route.hardwareInterface !== true || route.virtual !== false || route.status !== 'Up') {
    return unknown('non-physical-interface');
  }
  if (!clash || !PIPE_PATTERN.test(clash.pipe ?? '') || clash.controllerCount !== 1 || !clash.config || !Array.isArray(clash.connections)) {
    return unknown('clash-unavailable');
  }
  if (clash.config.tun?.enable === true) return unknown('clash-tun-enabled');
  if (clash.config.tun?.enable !== false) return unknown('clash-unavailable');
  for (const connection of clash.connections) {
    const metadata = connection?.metadata;
    if (!metadata || typeof metadata !== 'object') return unknown('clash-unavailable');
    const matchesTarget = sameAddress(metadata.destinationIP, config.server) || sameAddress(metadata.host, config.server);
    if (!matchesTarget || String(metadata.destinationPort) !== String(config.sshPort)) continue;
    if (!Array.isArray(connection.chains) || connection.chains.length === 0 || connection.chains.some(chain => typeof chain !== 'string')) {
      return unknown('clash-unavailable');
    }
    if (connection.chains.some(chain => chain !== 'DIRECT')) return unknown('clash-proxy');
  }
  const verified = result(config, 'verified-direct', now);
  verified.evidence = {
    sourceAddress: tunnel.sourceAddress,
    interfaceAlias: typeof route.interfaceAlias === 'string' ? route.interfaceAlias.slice(0, 128) : '',
    tunEnabled: false,
    ...(typeof clash.config.mode === 'string' && ['rule', 'global', 'direct'].includes(clash.config.mode)
      ? { clashMode: clash.config.mode } : {}),
  };
  return verified;
}

export function readPipeJson(pipe, path, { signal, deadlineMs = 3000, maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!PIPE_PATTERN.test(pipe) || !['/configs', '/connections'].includes(path)) return Promise.reject(new Error('Invalid pipe request'));
  return new Promise((accept, reject) => {
    const req = request({ socketPath: `\\\\.\\pipe\\${pipe}`, path, method: 'GET', signal, agent: false, headers: { Host: 'localhost' } });
    const fail = error => { reject(error); req.destroy(); };
    const timer = setTimeout(() => fail(new Error('Controller deadline exceeded')), deadlineMs);
    req.once('error', reject);
    req.once('close', () => clearTimeout(timer));
    req.once('response', response => {
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error('Controller unavailable'));
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) fail(new Error('Controller response too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Invalid controller response')); }
      });
    });
    req.end();
  });
}

function inspectPowerShell(config, signal) {
  return new Promise((accept, reject) => {
    execFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, '-Server', config.server, '-SshPort', String(config.sshPort),
    ], { windowsHide: true, signal, timeout: 10000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { accept(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
      catch { reject(new Error('Invalid Windows inspection')); }
    });
  });
}

export async function inspectWindowsRoute({ server, sshPort, signal }) {
  if (process.platform !== 'win32') return { reason: 'probe-failed' };
  const inspection = await inspectPowerShell({ server, sshPort }, signal);
  if (inspection.reason) return inspection;
  const pipes = inspection.pipes;
  if (!Array.isArray(pipes) || pipes.length !== 1 || !PIPE_PATTERN.test(pipes[0])) return { reason: 'clash-unavailable' };
  try {
    const [config, connections] = await Promise.all([
      readPipeJson(pipes[0], '/configs', { signal }),
      readPipeJson(pipes[0], '/connections', { signal }),
    ]);
    return { ...inspection, clash: { pipe: pipes[0], controllerCount: 1, config, connections: connections?.connections } };
  } catch {
    return { reason: 'clash-unavailable' };
  }
}

export function createRouteServer({ server, sshPort = 22, inspect = inspectWindowsRoute, now = Date.now, cacheMs = 3000, timeoutMs = 12000 }) {
  const config = validateConfig({ server, sshPort });
  if (cacheMs < 0 || cacheMs > 3000 || timeoutMs <= 0 || timeoutMs > 12000) throw new Error('Invalid probe timing');
  let cached = null;
  let inFlight = null;

  function acquire() {
    if (cached && now() - cached.at >= 0 && now() - cached.at < cacheMs) {
      return { promise: Promise.resolve(cached.value), release() {} };
    }
    if (!inFlight) {
      const controller = new AbortController();
      const flight = { controller, users: 0, promise: null, cancelReason: 'probe-cancelled' };
      inFlight = flight;
      const timeout = setTimeout(() => {
        flight.cancelReason = 'probe-timeout';
        controller.abort();
      }, timeoutMs);
      const aborted = new Promise(resolveAbort => controller.signal.addEventListener('abort', () => resolveAbort(result(config, flight.cancelReason, now())), { once: true }));
      const probed = Promise.resolve().then(() => inspect({ ...config, signal: controller.signal }))
        .then(observation => classifyRoute(observation, config, now()))
        .catch(() => result(config, 'probe-failed', now()));
      flight.promise = Promise.race([probed, aborted]).then(value => {
        if (!controller.signal.aborted) cached = { value, at: now() };
        else cached = null;
        return value;
      }).finally(() => {
        clearTimeout(timeout);
        if (inFlight === flight) inFlight = null;
      });
    }
    const flight = inFlight;
    flight.users += 1;
    let released = false;
    return {
      promise: flight.promise,
      release() {
        if (released) return;
        released = true;
        flight.users -= 1;
        if (flight.users === 0 && inFlight === flight) {
          cached = null;
          flight.controller.abort();
        }
      },
    };
  }

  const httpServer = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Vary', 'Origin');
    const countHeader = name => req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
    const fail = (status, error) => { res.writeHead(status); res.end(JSON.stringify({ error })); };
    if (req.headers.host !== HELPER_HOST || countHeader('host') !== 1) { fail(403, 'Forbidden host'); return; }
    if (req.headers.origin !== ALLOWED_ORIGIN || countHeader('origin') !== 1) { fail(403, 'Forbidden origin'); return; }
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    if (req.url !== '/route') { fail(404, 'Not found'); return; }
    if (req.method === 'OPTIONS') {
      if (req.headers['access-control-request-method'] !== 'GET' || req.headers['access-control-request-headers']) {
        fail(403, 'Forbidden preflight'); return;
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); fail(405, 'Method not allowed'); return; }
    const subscription = acquire();
    res.once('close', subscription.release);
    try {
      const value = await subscription.promise;
      if (!res.destroyed) res.end(JSON.stringify(value));
    } finally { subscription.release(); }
  });
  httpServer.requestTimeout = 8000;
  httpServer.headersTimeout = 8000;
  httpServer.keepAliveTimeout = 1000;
  httpServer.once('close', () => { cached = null; inFlight?.controller.abort(); });
  return httpServer;
}

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--server', '--ssh-port'].includes(name) || index + 1 >= args.length || Object.hasOwn(options, name)) {
      throw new Error('Usage: node scripts/local-route-helper.mjs --server <IP> [--ssh-port <port>]');
    }
    options[name] = args[index + 1];
  }
  const port = options['--ssh-port'];
  if (port !== undefined && !/^\d+$/.test(port)) throw new Error('Invalid --ssh-port');
  return validateConfig({ server: options['--server'], sshPort: port === undefined ? 22 : Number(port) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = parseArguments(process.argv.slice(2));
    const httpServer = createRouteServer(config);
    httpServer.on('error', error => {
      process.stderr.write(`Local route helper failed: ${error.code ?? 'unknown error'}\n`);
      process.exitCode = 1;
    });
    httpServer.listen(3101, '127.0.0.1', () => {
      process.stdout.write(`Local route helper listening on http://${HELPER_HOST}; server ${config.server}:${config.sshPort}\n`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { httpServer.close(); httpServer.closeAllConnections(); });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
