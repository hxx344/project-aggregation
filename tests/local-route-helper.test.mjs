import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { ALLOWED_ORIGIN, HELPER_HOST, SERVICE, classifyRoute, createRouteServer, parseArguments, readPipeJson } from '../scripts/local-route-helper.mjs';

const configuration = { server: '203.0.113.10', sshPort: 22 };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
};
function observation() {
  return {
    tunnel: { processName: 'ssh.exe', listenerOwners: 1, connectionCount: 1, state: 'Established', server: configuration.server, sshPort: 22, sourceAddress: '192.0.2.5' },
    route: { sourceAddress: '192.0.2.5', hardwareInterface: true, virtual: false, status: 'Up', interfaceAlias: 'Ethernet' },
    clash: { pipe: 'mihomo', controllerCount: 1, config: { mode: 'rule', tun: { enable: false } }, connections: [] },
  };
}

test('CLI requires a literal IP and validates its fixed argument surface', () => {
  assert.deepEqual(parseArguments(['--server', configuration.server]), configuration);
  assert.deepEqual(parseArguments(['--server', '2001:db8::1', '--ssh-port', '2222']), { server: '2001:db8::1', sshPort: 2222 });
  for (const args of [[], ['--server', 'example.com'], ['--server', '127.1'], ['--server', 'fe80::1%3'], ['--server', '1.2.3.999'], ['--server', configuration.server, '--target', 'anything'], ['--server', configuration.server, '--server', configuration.server]]) {
    assert.throws(() => parseArguments(args));
  }
  for (const port of ['0', '65536', '22.5', '-1', '1e2', '', '22x']) assert.throws(() => parseArguments(['--server', configuration.server, '--ssh-port', port]));
});

test('direct requires matching SSH, source, physical interface and explicit disabled TUN', () => {
  const observed = observation();
  observed.clash.config.secret = 'must-never-leave-helper';
  observed.clash.connections = [{ metadata: { destinationIP: configuration.server, destinationPort: '22' }, chains: ['DIRECT'] }];
  const value = classifyRoute(observed, configuration, 1700000000000);
  assert.deepEqual(value, {
    service: SERVICE, schema: 1, state: 'direct', reason: 'verified-direct', ...configuration,
    checkedAt: '2023-11-14T22:13:20.000Z',
    evidence: { sourceAddress: '192.0.2.5', interfaceAlias: 'Ethernet', tunEnabled: false, clashMode: 'rule' },
  });
  assert.ok(!JSON.stringify(value).includes('must-never-leave-helper'));
  assert.ok(!JSON.stringify(value).includes('mihomo'));
});

test('IPv6 comparison accepts equivalent address spellings without ignoring target or source', () => {
  const observed = observation();
  observed.tunnel.server = '2001:db8:0:0:0:0:0:1';
  observed.tunnel.sourceAddress = '2001:db8::2';
  observed.route.sourceAddress = '2001:db8:0:0:0:0:0:2';
  assert.equal(classifyRoute(observed, { server: '2001:db8::1', sshPort: 22 }).state, 'direct');
});

test('missing, conflicting or proxy evidence cannot produce direct', () => {
  const cases = [
    ['ssh-not-found', value => { delete value.tunnel; }],
    ['ssh-not-found', value => { value.tunnel.processName = 'node.exe'; }],
    ['ssh-not-found', value => { value.tunnel.listenerOwners = 2; }],
    ['multiple-connections', value => { value.tunnel.connectionCount = 2; }],
    ['target-mismatch', value => { value.tunnel.server = '203.0.113.20'; }],
    ['target-mismatch', value => { value.tunnel.sshPort = 2222; }],
    ['target-mismatch', value => { value.tunnel.state = 'SynSent'; }],
    ['source-mismatch', value => { value.route.sourceAddress = '192.0.2.6'; }],
    ['source-mismatch', value => { delete value.route; }],
    ['non-physical-interface', value => { value.route.hardwareInterface = false; }],
    ['non-physical-interface', value => { value.route.virtual = true; }],
    ['non-physical-interface', value => { value.route.status = 'Disconnected'; }],
    ['clash-unavailable', value => { delete value.clash; }],
    ['clash-unavailable', value => { value.clash.controllerCount = 2; }],
    ['clash-unavailable', value => { value.clash.pipe = '../arbitrary'; }],
    ['clash-unavailable', value => { delete value.clash.config.tun; }],
    ['clash-unavailable', value => { value.clash.config.tun.enable = 'false'; }],
    ['clash-tun-enabled', value => { value.clash.config.tun.enable = true; }],
    ['clash-unavailable', value => { value.clash.connections = [{}]; }],
    ['clash-proxy', value => { value.clash.connections = [{ metadata: { destinationIP: configuration.server, destinationPort: 22 }, chains: ['DIRECT', 'Proxy'] }]; }],
    ['clash-proxy', value => { value.clash.connections = [{ metadata: { host: configuration.server, destinationPort: '22' }, chains: ['Proxy'] }]; }],
    ['clash-unavailable', value => { value.clash.connections = [{ metadata: { destinationIP: configuration.server, destinationPort: 22 }, chains: [] }]; }],
  ];
  for (const [reason, mutate] of cases) {
    const observed = observation();
    mutate(observed);
    const actual = classifyRoute(observed, configuration);
    assert.equal(actual.state, 'unknown', reason);
    assert.equal(actual.reason, reason);
    assert.equal(actual.evidence, undefined);
  }
  assert.equal(classifyRoute({ reason: 'unsupported-private-value' }, configuration).reason, 'probe-failed');
});

test('proxy connections to unrelated peers do not override independently verified SSH', () => {
  const observed = observation();
  observed.clash.connections = [{ metadata: { destinationIP: '203.0.113.50', destinationPort: 443 }, chains: ['Proxy'] }];
  assert.equal(classifyRoute(observed, configuration).state, 'direct');
});

async function fixture(t, options = {}) {
  const server = createRouteServer({ ...configuration, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  function begin({ headers = {}, method = 'GET', path = '/route', rawHeaders } = {}) {
    let req;
    const response = new Promise((accept, reject) => {
      req = request({ host: '127.0.0.1', port: server.address().port, path, method, agent: false, headers: rawHeaders ?? { Host: HELPER_HOST, Origin: ALLOWED_ORIGIN, ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          accept({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    return { req, response };
  }
  return { begin, get: options => begin(options).response };
}

test('Host, Origin, method, path and preflight rejection never invoke inspection', async t => {
  let calls = 0;
  const { get } = await fixture(t, { inspect: () => { calls += 1; return observation(); } });
  const rejected = [
    [{ headers: { Host: 'localhost:3101' } }, 403],
    [{ headers: { Host: 'attacker.example:3101' } }, 403],
    [{ headers: { Origin: 'http://hub.localhost:3100.evil.example' } }, 403],
    [{ headers: { Origin: 'null' } }, 403],
    [{ rawHeaders: ['Host', HELPER_HOST] }, 403],
    [{ rawHeaders: ['Host', HELPER_HOST, 'Host', HELPER_HOST, 'Origin', ALLOWED_ORIGIN] }, 403],
    [{ rawHeaders: ['Host', HELPER_HOST, 'Origin', ALLOWED_ORIGIN, 'Origin', ALLOWED_ORIGIN] }, 403],
    [{ method: 'POST' }, 405],
    [{ method: 'HEAD' }, 405],
    [{ path: '/route?server=203.0.113.20' }, 404],
    [{ path: '/configs' }, 404],
    [{ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } }, 403],
    [{ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization' } }, 403],
  ];
  for (const [requestOptions, status] of rejected) assert.equal((await get(requestOptions)).status, status, JSON.stringify(requestOptions));
  const preflight = await get({ method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
  assert.equal(calls, 0);
});

test('concurrent valid requests share a probe and cache expires after three seconds', async t => {
  let now = 1700000000000;
  let calls = 0;
  const started = deferred();
  const pending = deferred();
  const { begin, get } = await fixture(t, { now: () => now, inspect: () => { calls += 1; started.resolve(); return pending.promise; } });
  const first = begin();
  await started.promise;
  const second = begin();
  await flush();
  pending.resolve(observation());
  const results = await Promise.all([first.response, second.response]);
  assert.ok(results.every(value => value.body.state === 'direct'));
  assert.equal(calls, 1);
  assert.equal(results[0].headers['cache-control'], 'no-store');
  now += 2999;
  assert.equal((await get()).body.checkedAt, results[0].body.checkedAt);
  assert.equal(calls, 1);
  now += 1;
  assert.equal((await get()).body.state, 'direct');
  assert.equal(calls, 2);
});

test('probe timeout clears a previous direct result and ignores a late completion', async t => {
  let calls = 0;
  let signal;
  const pending = deferred();
  const { get } = await fixture(t, { cacheMs: 0, timeoutMs: 30, inspect: context => {
    calls += 1;
    signal = context.signal;
    return calls === 1 ? observation() : pending.promise;
  } });
  assert.equal((await get()).body.state, 'direct');
  const expired = await get();
  assert.equal(expired.body.state, 'unknown');
  assert.equal(expired.body.reason, 'probe-timeout');
  assert.equal(signal.aborted, true);
  pending.resolve(observation());
  await flush();
  await get();
  assert.equal(calls, 3);
});

test('disconnecting the last subscriber aborts its probe and does not cache its result', async t => {
  let calls = 0;
  let signal;
  const started = deferred();
  const aborted = deferred();
  const pending = deferred();
  const { begin, get } = await fixture(t, { inspect: context => {
    calls += 1;
    signal = context.signal;
    signal.addEventListener('abort', aborted.resolve, { once: true });
    started.resolve();
    return calls === 1 ? pending.promise : observation();
  } });
  const first = begin();
  const firstOutcome = first.response.catch(() => null);
  await started.promise;
  first.req.destroy();
  await aborted.promise;
  assert.equal(signal.aborted, true);
  pending.resolve(observation());
  await firstOutcome;
  await flush();
  assert.equal((await get()).body.state, 'direct');
  assert.equal(calls, 2);
});

test('one disconnected subscriber does not abort a probe still needed by another', async t => {
  let signal;
  const started = deferred();
  const pending = deferred();
  const { begin } = await fixture(t, { inspect: context => { signal = context.signal; started.resolve(); return pending.promise; } });
  const first = begin();
  const firstOutcome = first.response.catch(() => null);
  await started.promise;
  const second = begin();
  // Wait until the second request is on its socket before closing the first.
  await new Promise(resolve => second.req.once('finish', resolve));
  await new Promise(resolve => setTimeout(resolve, 15));
  first.req.destroy();
  await firstOutcome;
  await flush();
  assert.equal(signal.aborted, false);
  pending.resolve(observation());
  assert.equal((await second.response).body.state, 'direct');
});

test('inspection failure returns a safe unknown without leaking the exception', async t => {
  const { get } = await fixture(t, { inspect: () => { throw new Error('private exception'); } });
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.body.reason, 'probe-failed');
  assert.ok(!JSON.stringify(response.body).includes('private exception'));
});

test('named pipe reads enforce a small read-only surface, body limit and deadline', { skip: process.platform !== 'win32' }, async t => {
  const pipe = `verge-mihomo-sidecar-route-test-${process.pid}`;
  let mode = 'valid';
  const seen = [];
  const controller = createServer((req, res) => {
    seen.push([req.method, req.url]);
    if (mode === 'stall') return;
    if (mode === 'status') { res.writeHead(401); res.end(); return; }
    res.end(mode === 'large' ? 'x'.repeat(1025) : mode === 'invalid' ? '{' : '{"tun":{"enable":false}}');
  });
  controller.listen(`\\\\.\\pipe\\${pipe}`);
  await once(controller, 'listening');
  t.after(() => new Promise(resolve => { controller.close(resolve); controller.closeAllConnections(); }));
  assert.deepEqual(await readPipeJson(pipe, '/configs'), { tun: { enable: false } });
  assert.deepEqual(seen, [['GET', '/configs']]);
  await assert.rejects(readPipeJson('arbitrary-pipe', '/configs'));
  await assert.rejects(readPipeJson(pipe, '/restart'));
  for (mode of ['status', 'invalid', 'large']) await assert.rejects(readPipeJson(pipe, '/connections', { maxBytes: 1024 }));
  mode = 'stall';
  await assert.rejects(readPipeJson(pipe, '/configs', { deadlineMs: 25 }), /deadline/);
  const abort = new AbortController();
  const pendingRead = readPipeJson(pipe, '/configs', { signal: abort.signal });
  abort.abort();
  await assert.rejects(pendingRead, /abort/i);
});
