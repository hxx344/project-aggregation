import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { createVariationalFetch } from '../server/variational-transport.mjs';

const ORIGIN = 'https://omni.variational.io', ME = `${ORIGIN}/api/me`;
const FUNDING = `${ORIGIN}/api/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future`;
const TOKEN = 'e30.eyJleHAiOjE4MDAwMDAwMDB9.test';
const authenticated = { headers: { Cookie: `vr-token=${TOKEN}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, redirect: 'error' };
const body = symbol => JSON.stringify({ instrument: { underlying: symbol, instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind: 'commodity' }, qty: '1' });
const output = (body = '{}', headers = { 'content-type': 'application/json' }, status = 200) => JSON.stringify({ status, headers, body: Buffer.from(body).toString('base64') });

function processFixture(behavior = child => child.finish(output())) {
  const invocations = [], children = [];
  const spawnImpl = (command, args, options) => {
    invocations.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = []; child.input = '';
    child.stdin.on('data', chunk => { child.input += chunk.toString(); });
    child.stdin.on('finish', () => queueMicrotask(() => behavior(child)));
    child.finish = (stdout, code = 0, stderr = '') => {
      if (stderr) child.stderr.write(stderr);
      if (stdout) child.stdout.write(stdout);
      child.emit('close', code, null);
    };
    child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true; };
    children.push(child);
    return child;
  };
  return { spawnImpl, invocations, children };
}

test('bridge puts credentials only on stdin and invokes an isolated fixed Python helper without shell or visible window', async () => {
  const fixture = processFixture(child => child.finish(output(JSON.stringify({ token: TOKEN }))));
  const response = await createVariationalFetch({ spawnImpl: fixture.spawnImpl, platform: 'win32' })(ME, authenticated);
  assert.equal(response.status, 200); assert.equal((await response.json()).token, TOKEN);
  const call = fixture.invocations[0], payload = JSON.parse(fixture.children[0].input);
  assert.equal(call.command, 'python'); assert.equal(call.args[0], '-I'); assert.equal(call.args.length, 2);
  assert.ok(isAbsolute(call.args[1])); assert.match(call.args[1], /variational-request\.py$/);
  assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']); assert.equal(call.options.env, undefined);
  assert.ok(!JSON.stringify(call).includes(TOKEN));
  assert.equal(payload.headers.Cookie, `vr-token=${TOKEN}`); assert.equal(payload.url, ME); assert.equal(payload.method, 'GET');
  assert.equal(payload.headers.Accept, 'application/json'); assert.equal(payload.headers['Cache-Control'], 'no-cache');
  assert.equal(payload.headers.Referer, `${ORIGIN}/`); assert.match(payload.headers['User-Agent'], /Chrome\/140\.0\.0\.0/);
});

test('anonymous funding uses python3 on Linux and always omits Cookie', async () => {
  const fixture = processFixture();
  await createVariationalFetch({ spawnImpl: fixture.spawnImpl, platform: 'linux' })(new URL(FUNDING), { method: 'GET' });
  assert.equal(fixture.invocations[0].command, 'python3');
  const payload = JSON.parse(fixture.children[0].input);
  assert.equal(payload.method, 'GET'); assert.equal(payload.body, null); assert.ok(!Object.hasOwn(payload.headers, 'Cookie'));
  await assert.rejects(createVariationalFetch({ spawnImpl: fixture.spawnImpl })(FUNDING, authenticated), { code: 'VARIATIONAL_REQUEST_INVALID' });
  assert.equal(fixture.invocations.length, 1);
});

test('both valid commodity indicative bodies use fixed POST and all non-read-only shapes are rejected before spawning', async () => {
  const fixture = processFixture(), fetcher = createVariationalFetch({ spawnImpl: fixture.spawnImpl });
  for (const symbol of ['BZ', 'CL']) {
    await fetcher(`${ORIGIN}/api/quotes/indicative`, { ...authenticated, method: 'POST', body: body(symbol) });
    const payload = JSON.parse(fixture.children.at(-1).input);
    assert.equal(payload.method, 'POST'); assert.equal(payload.headers['Content-Type'], 'application/json');
    assert.deepEqual(payload.body, JSON.parse(body(symbol)));
  }
  for (const patch of [{ qty: '2' }, { qty: 1 }, { side: 'buy' }, { instrument: { ...JSON.parse(body('BZ')).instrument, underlying: 'BTC' } }, { instrument: { ...JSON.parse(body('BZ')).instrument, instrument_type: 'swap' } }]) {
    await assert.rejects(fetcher(`${ORIGIN}/api/quotes/indicative`, { ...authenticated, method: 'POST', body: JSON.stringify({ ...JSON.parse(body('BZ')), ...patch }) }), { code: 'VARIATIONAL_REQUEST_INVALID' });
  }
  assert.equal(fixture.invocations.length, 2);
});

test('URL, method, headers, redirects, bodies, and missing credentials cannot widen the network capability', async () => {
  const fixture = processFixture(), fetcher = createVariationalFetch({ spawnImpl: fixture.spawnImpl });
  const cases = [
    ['https://evil.invalid/api/me', authenticated], ['http://omni.variational.io/api/me', authenticated],
    [`${ORIGIN}:444/api/me`, authenticated], [`${ME}?redirect=https://evil.invalid`, authenticated],
    [`${ME}#secret`, authenticated], ['https://user:password@omni.variational.io/api/me', authenticated],
    [`${ORIGIN}/api/orders/new/market`, authenticated], [`${FUNDING}&other=1`, {}],
    [FUNDING.replace('underlying=BZ', 'underlying=BTC'), {}], [ME, { ...authenticated, method: 'DELETE' }],
    [ME, { ...authenticated, redirect: 'follow' }], [ME, { ...authenticated, body: '{}' }], [ME, {}],
    [ME, { headers: { Cookie: `vr-token=${TOKEN}; other=value` } }],
    [ME, { headers: { Cookie: `vr-token=${TOKEN}`, Authorization: 'Bearer secret' } }],
    [ME, { headers: { Cookie: `vr-token=${TOKEN}`, Referer: 'https://evil.invalid/' } }],
    [ME, { headers: { Cookie: `vr-token=${TOKEN}\r\nInjected: secret` } }], [ME, { ...authenticated, signal: {} }],
  ];
  for (const [url, init] of cases) await assert.rejects(fetcher(url, init), { code: 'VARIATIONAL_REQUEST_INVALID' });
  assert.equal(fixture.invocations.length, 0);
});

test('status, response body and only selected classification headers are projected to Response', async () => {
  const fixture = processFixture(child => child.finish(output('<html>challenge</html>', { 'content-type': 'text/html', 'cf-mitigated': 'challenge', 'x-omni-auth': 'r' }, 403)));
  const response = await createVariationalFetch({ spawnImpl: fixture.spawnImpl })(ME, authenticated);
  assert.equal(response.status, 403); assert.equal(response.headers.get('cf-mitigated'), 'challenge');
  assert.equal(response.headers.get('x-omni-auth'), 'r'); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), '<html>challenge</html>');
});

test('malformed helper output, unexpected headers, oversized response and process failures expose only fixed safe errors', async () => {
  const failures = [
    child => child.finish(TOKEN), child => child.finish(output('{}', { 'set-cookie': `vr-token=${TOKEN}` })),
    child => child.finish(output('{}', { 'content-type': `application/json\r\n${TOKEN}` })),
    child => child.finish(output('x'.repeat(2_000_001))), child => child.finish('', 2, `traceback ${TOKEN}`),
    child => child.finish(JSON.stringify({ status: 200, headers: {}, body: '**invalid-base64**' })),
  ];
  for (const behavior of failures) {
    const fixture = processFixture(behavior);
    await assert.rejects(createVariationalFetch({ spawnImpl: fixture.spawnImpl })(ME, authenticated), error => {
      assert.equal(error.code, 'VARIATIONAL_TRANSPORT_FAILURE'); assert.ok(!error.message.includes(TOKEN)); return true;
    });
  }
});

test('stdout and discarded stderr are bounded and oversized processes are killed', async () => {
  for (const behavior of [child => child.stdout.write(Buffer.alloc(3_000_001)), child => child.stderr.write(Buffer.alloc(16_385))]) {
    const fixture = processFixture(behavior);
    await assert.rejects(createVariationalFetch({ spawnImpl: fixture.spawnImpl })(ME, authenticated), { code: 'VARIATIONAL_TRANSPORT_FAILURE' });
    assert.deepEqual(fixture.children[0].kills, ['SIGKILL']);
  }
});

test('the full allowed 2 MB response survives base64 projection without reducing the body limit', async () => {
  const fixture = processFixture(child => child.finish(output('x'.repeat(2_000_000))));
  const response = await createVariationalFetch({ spawnImpl: fixture.spawnImpl })(ME, authenticated);
  assert.equal((await response.arrayBuffer()).byteLength, 2_000_000);
});

test('timeout and abort kill the child; caller abort reasons never become error messages', async () => {
  const timed = processFixture(() => {});
  await assert.rejects(createVariationalFetch({ spawnImpl: timed.spawnImpl, timeoutMs: 5 })(ME, authenticated), { code: 'VARIATIONAL_TIMEOUT', name: 'TimeoutError' });
  assert.deepEqual(timed.children[0].kills, ['SIGKILL']);
  const controller = new AbortController(), running = processFixture(() => {});
  const pending = createVariationalFetch({ spawnImpl: running.spawnImpl })(ME, { ...authenticated, signal: controller.signal });
  controller.abort(new Error(TOKEN));
  await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes(TOKEN));
  assert.deepEqual(running.children[0].kills, ['SIGKILL']);
  const before = processFixture();
  await assert.rejects(createVariationalFetch({ spawnImpl: before.spawnImpl })(ME, { ...authenticated, signal: controller.signal }), { code: 'VARIATIONAL_ABORTED' });
  assert.equal(before.invocations.length, 0);
});

test('missing Python is explicit and does not become token rejection or leak process error details', async () => {
  const fixture = processFixture(child => child.emit('error', Object.assign(new Error(TOKEN), { code: 'ENOENT' })));
  await assert.rejects(createVariationalFetch({ spawnImpl: fixture.spawnImpl })(ME, authenticated), error => {
    assert.equal(error.code, 'VARIATIONAL_PYTHON_MISSING'); assert.match(error.message, /Python 3/);
    assert.ok(!error.message.includes(TOKEN)); assert.equal(error.rejected, undefined); return true;
  });
});

test('Python stdlib helper revalidates the capability, blocks redirects, bounds reads and suppresses exception details offline', () => {
  const script = String.raw`
import base64, copy, io, json, sys, unittest, urllib.error
from email.message import Message
from unittest.mock import Mock, patch

scope = {"__name__": "variational_offline"}
with open(sys.argv[1], encoding="utf-8") as source:
    exec(compile(source.read(), sys.argv[1], "exec"), scope)
ORIGIN = "https://omni.variational.io"
COOKIE = "vr-token=e30.eyJleHAiOjE4MDAwMDAwMDB9.test"
BASE_HEADERS = {"Accept": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36", "Cache-Control": "no-cache", "Referer": ORIGIN + "/"}

def payload(path="/api/me"):
    headers = dict(BASE_HEADERS)
    if path == "/api/me": headers["Cookie"] = COOKIE
    return {"url": ORIGIN + path, "method": "GET", "headers": headers, "body": None}

class Response(io.BytesIO):
    def __init__(self, content=b'{}', status=200, headers=None):
        super().__init__(content)
        self.status = status
        self.headers = Message()
        for key, value in (headers or {"content-type": "application/json"}).items(): self.headers[key] = value
        self.read_sizes = []
    def read(self, size=-1):
        self.read_sizes.append(size)
        return super().read(size)

class BridgeTests(unittest.TestCase):
    def test_fixed_destination_and_cookie_policy(self):
        funding = payload("/api/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future")
        request = scope["request_definition"](funding)
        self.assertEqual(request.full_url, funding["url"])
        self.assertIsNone(request.get_header("Cookie"))
        variants = []
        for key, value in [("url", "https://evil.invalid/api/me"), ("url", ORIGIN + "/api/me?x=1"), ("method", "POST"), ("body", {})]:
            invalid = payload(); invalid[key] = value; variants.append(invalid)
        for key, value in [("Cookie", COOKIE + "; other=secret"), ("Cookie", COOKIE + "\r\nInjected: secret"), ("Referer", "https://evil.invalid/"), ("Authorization", "Bearer secret"), ("User-Agent", "custom")]:
            invalid = payload(); invalid["headers"][key] = value; variants.append(invalid)
        invalid = payload(); del invalid["headers"]["Cookie"]; variants.append(invalid)
        invalid = copy.deepcopy(funding); invalid["headers"]["Cookie"] = COOKIE; variants.append(invalid)
        for invalid in variants:
            with self.assertRaises(ValueError): scope["request_definition"](invalid)

    def test_post_only_fixed_commodity_quote(self):
        value = payload()
        value.update(url=ORIGIN + "/api/quotes/indicative", method="POST", body={"instrument": {"underlying": "CL", "instrument_type": "perpetual_rwa_future", "settlement_asset": "USDC", "kind": "commodity"}, "qty": "1"})
        value["headers"]["Content-Type"] = "application/json"
        request = scope["request_definition"](value)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), value["body"])
        for patch in [{"qty": "2"}, {"side": "buy"}, {"instrument": {**value["body"]["instrument"], "kind": "index"}}]:
            invalid = copy.deepcopy(value); invalid["body"].update(patch)
            with self.assertRaises(ValueError): scope["request_definition"](invalid)

    def test_bounded_read_no_redirect_and_header_projection(self):
        response = Response(b'{"ok":true}', headers={"content-type": "application/json", "x-omni-auth": "r", "cf-mitigated": "challenge", "Set-Cookie": COOKIE, "Location": "https://evil.invalid"})
        opener = Mock(); opener.open.return_value = response
        with patch.object(scope["urllib"].request, "build_opener", return_value=opener) as builder:
            result = scope["fetch_response"](payload())
        self.assertIsInstance(builder.call_args.args[0], scope["NoRedirect"])
        self.assertIsNone(builder.call_args.args[0].redirect_request(None, None, 302, "redirect", {}, "https://evil.invalid"))
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 8)
        self.assertEqual(response.read_sizes, [2_000_001])
        self.assertEqual(set(result["headers"]), {"content-type", "x-omni-auth", "cf-mitigated"})
        self.assertEqual(base64.b64decode(result["body"]), b'{"ok":true}')

    def test_http_error_keeps_classification_without_following_location(self):
        for status in (302, 403):
            headers = Message(); headers["content-type"] = "text/html"; headers["cf-mitigated"] = "challenge"; headers["Location"] = "https://evil.invalid"; headers["Set-Cookie"] = COOKIE
            error = urllib.error.HTTPError(ORIGIN + "/api/me", status, "private upstream error", headers, io.BytesIO(b"challenge"))
            opener = Mock(); opener.open.side_effect = error
            with patch.object(scope["urllib"].request, "build_opener", return_value=opener): result = scope["fetch_response"](payload())
            self.assertEqual(result["status"], status)
            self.assertNotIn("Location", result["headers"])
            self.assertNotIn("set-cookie", result["headers"])
            self.assertEqual(opener.open.call_count, 1)

    def test_oversize_response_is_rejected(self):
        opener = Mock(); opener.open.return_value = Response(b"x" * 2_000_001)
        with patch.object(scope["urllib"].request, "build_opener", return_value=opener):
            with self.assertRaises(ValueError): scope["fetch_response"](payload())

    def test_main_does_not_print_exception_or_input(self):
        for raw in (b"x" * 32_769, b'{"url":"one","url":"two"}', json.dumps(payload()).encode()):
            captured = io.StringIO(); errors = io.StringIO()
            with patch.object(scope["sys"], "stdin", io.TextIOWrapper(io.BytesIO(raw))), patch.object(scope["sys"], "stdout", captured), patch.object(scope["sys"], "stderr", errors), patch.object(scope["urllib"].request, "build_opener", side_effect=RuntimeError(COOKIE)):
                self.assertEqual(scope["main"](), 2)
            self.assertEqual(captured.getvalue(), "")
            self.assertEqual(errors.getvalue(), "")

suite = unittest.defaultTestLoader.loadTestsFromTestCase(BridgeTests)
result = unittest.TextTestRunner().run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', script, fileURLToPath(new URL('../server/variational-request.py', import.meta.url))], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000 });
  assert.equal(result.status, 0, `${result.error?.name || ''}\n${result.stderr}`);
});
