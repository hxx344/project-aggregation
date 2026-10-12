import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createPageHandler, pageHtml } from '../server/page-handler.mjs';
import { createHandler } from '../server/http.mjs';

const template = '<!doctype html><html><head><!--ssr-preload--></head><body><div id="root"><!--ssr-outlet--></div><script id="page-props" type="application/json"><!--ssr-props--></script><script type="module" src="/assets/app-deadbeef.js"></script></body></html>';
const literalMarkup = '<span>literal $& $` $\' <!--ssr-props--> <!--ssr-outlet--> <!--ssr-preload--></span>';
const unsafeNote = '</script><script>globalThis.injected = true</script><!--ssr-outlet--><!--ssr-props--><!--ssr-preload--> $& $` $\' \u2028 \u2029';
const assetText = 'console.log("page-handler-fixture");\n'.repeat(80);
const publicText = 'Current public market data.\n'.repeat(80);
const credentials = { username: 'page-fixture', password: 'test-password-only' };
const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;

function embeddedProps(html) {
  const match = /<script id="page-props" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'The response contains a complete, parseable hydration payload');
  return JSON.parse(match[1]);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'monitor-page-handler-test-'));
  const client = join(root, 'dist/client');
  const servers = [], handlers = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
    }
    for (const handler of handlers) await handler.close();
    // Delete only this test's uniquely created temporary directory.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.startsWith(join(tmpdir(), 'monitor-page-handler-test-')));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(['dist/client/assets', 'dist/client/.vite', 'dist/client/api', 'dist/server', 'private'].map(path => mkdir(join(root, path), { recursive: true })));
  const renderer = `export async function render(props, { signal }) {
    if (!(signal instanceof AbortSignal) || signal.aborted) throw new Error('Expected a live request signal');
    await new Promise(resolve => setTimeout(resolve, 1));
    return '<main data-fixture="ssr">revision:' + String(props.initial.hynix.quote?.revision ?? 'unavailable') + ${JSON.stringify(literalMarkup)} + '</main>';
  }`;
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' })),
    writeFile(join(client, 'index.html'), template),
    writeFile(join(client, '.vite/manifest.json'), JSON.stringify({ 'web/entry-client.tsx': { file: 'assets/app-deadbeef.js', css: ['assets/app-deadbeef.css'], isEntry: true } })),
    writeFile(join(client, 'assets/app-deadbeef.js'), assetText),
    writeFile(join(client, 'assets/app-deadbeef.css'), '.fixture{color:green}\n'.repeat(80)),
    writeFile(join(client, 'assets/app-deadbeef.js.map'), 'PRIVATE_SOURCE_MAP'),
    writeFile(join(client, 'public.txt'), publicText),
    writeFile(join(client, 'api/unknown'), 'RESERVED_API_FILE'),
    writeFile(join(client, '.env'), 'CLIENT_SECRET=must-not-be-served'),
    writeFile(join(root, '.env'), 'SERVER_SECRET=must-not-be-served'),
    writeFile(join(root, 'private/secret.txt'), 'PRIVATE_OUTSIDE_CLIENT'),
    writeFile(join(root, 'dist/server/entry-server.js'), renderer),
  ]);
  const state = { revision: 1, note: unsafeNote, unavailable: false, quoteReads: 0 };
  const services = new Map([['hynix', {
    actions: { quote: ['GET'] },
    async handle(action) {
      if (action !== 'quote') throw new Error('No persisted fixture for this action');
      state.quoteReads++;
      if (state.unavailable) throw new Error('Persisted quote unavailable');
      return { revision: state.revision, note: state.note, padding: 'cached market observation '.repeat(60) };
    },
  }]]);
  return {
    root, client, services, state,
    async start({ authenticated = false } = {}) {
      const page = await createPageHandler({ services, root });
      handlers.push(page);
      const listener = authenticated
        ? createHandler({ services, ...credentials, pageHandler: page.handle })
        : (request, response) => void page.handle(request, response).catch(error => {
          if (response.headersSent) response.destroy(error);
          else response.writeHead(500).end('Fixture render failed');
        });
      const server = createServer(listener);
      await new Promise((accept, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', accept);
      });
      servers.push(server);
      return (path, { method = 'GET', headers = {} } = {}) => new Promise((accept, reject) => {
        // A raw path preserves encoded traversal and backslashes that fetch/URL normalize.
        const request = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method, headers, agent: false }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('Fixture request timed out')));
        request.end();
      });
    },
  };
}

test('SSR keeps untrusted snapshots inside one JSON script and preserves literal template-like content', async t => {
  const f = await fixture(t), read = await f.start();
  const response = await read('/?monitor=hynix&goldOil=bz&goldOilExchange=bybit');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const html = response.body.toString();
  assert.ok(html.includes('revision:1'), 'The async renderer completes before sending the document');
  assert.ok(html.includes(literalMarkup), 'Dollar replacement tokens and nested markers remain literal rendered text');
  assert.equal((html.match(/<script(?:\s|>)/g) ?? []).length, 2, 'Snapshot text cannot create an extra script element');
  assert.ok(!html.includes('</script><script>globalThis.injected'));
  assert.ok(!html.includes('\u2028') && !html.includes('\u2029'), 'JSON line separators are escaped in the HTML');
  const props = embeddedProps(html);
  assert.equal(props.initial.hynix.quote.note, unsafeNote);
  assert.equal(props.initialMonitor, 'hynix');
  assert.equal(props.initialGoldOil, 'bz');
  assert.equal(props.initialGoldOilExchange, 'bybit');
  assert.equal(props.initial.oil.quote, null, 'An unavailable unrelated cache does not block SSR');
});

test('malformed templates fail rather than send duplicate or missing hydration sections', () => {
  const props = { initialMonitor: 'hynix', note: unsafeNote };
  for (const marker of ['<!--ssr-outlet-->', '<!--ssr-props-->', '<!--ssr-preload-->']) {
    assert.throws(() => pageHtml(template.replace(marker, ''), literalMarkup, props), /Invalid page template/);
    assert.throws(() => pageHtml(template + marker, literalMarkup, props), /Invalid page template/);
  }
});

test('each page reads current snapshots and degrades missing data without serving stale static HTML', async t => {
  const f = await fixture(t), read = await f.start();
  const first = await read('/');
  assert.equal(embeddedProps(first.body.toString()).initial.hynix.quote.revision, 1);
  f.state.revision = 2;
  const second = await read('/');
  assert.equal(embeddedProps(second.body.toString()).initial.hynix.quote.revision, 2);
  assert.match(second.body.toString(), /revision:2/);
  assert.equal(f.state.quoteReads, 2);
  f.state.unavailable = true;
  const unavailable = await read('/?monitor=unrecognized&goldOil=unknown&goldOilExchange=unknown');
  assert.equal(unavailable.status, 200);
  const props = embeddedProps(unavailable.body.toString());
  assert.equal(props.initial.hynix.quote, null);
  assert.equal(props.initialMonitor, 'oil');
  assert.equal(props.initialGoldOil, 'cl');
  assert.equal(props.initialGoldOilExchange, 'binance');
  assert.match(unavailable.body.toString(), /revision:unavailable/);
});

test('GET and HEAD negotiate gzip and cache only fingerprinted assets as immutable', async t => {
  const f = await fixture(t), read = await f.start();
  for (const path of ['/', '/assets/app-deadbeef.js', '/assets/app-deadbeef.css', '/public.txt']) {
    const plain = await read(path);
    assert.equal(plain.status, 200, path);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(Number(plain.headers['content-length']), plain.body.length);
    assert.equal(plain.headers['x-content-type-options'], 'nosniff');
    assert.equal(plain.headers.vary, 'Accept-Encoding');
    const head = await read(path, { method: 'HEAD' });
    assert.equal(head.status, 200, path);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], plain.headers['content-length']);
    assert.equal(head.headers['content-type'], plain.headers['content-type']);
    const zipped = await read(path, { headers: { 'Accept-Encoding': 'br, gzip;q=0.5' } });
    assert.equal(zipped.headers['content-encoding'], 'gzip', path);
    assert.equal(Number(zipped.headers['content-length']), zipped.body.length);
    const decoded = gunzipSync(zipped.body);
    if (path === '/') assert.equal(embeddedProps(decoded.toString()).initial.hynix.quote.revision, 1);
    else assert.deepEqual(decoded, plain.body);
    assert.ok(zipped.body.length < decoded.length);
    const zippedHead = await read(path, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(zippedHead.headers['content-encoding'], 'gzip');
    assert.equal(zippedHead.body.length, 0);
    if (path !== '/') assert.equal(zippedHead.headers['content-length'], zipped.headers['content-length']);
    const disabled = await read(path, { headers: { 'Accept-Encoding': 'gzip;q=0.000, identity' } });
    assert.equal(disabled.headers['content-encoding'], undefined, 'An explicit zero preference must disable gzip');
    const expectedCache = path.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : path === '/' ? 'private, no-store' : 'private, max-age=0, must-revalidate';
    assert.equal(plain.headers['cache-control'], expectedCache);
    assert.equal(zipped.headers['cache-control'], expectedCache);
    assert.equal(head.headers['cache-control'], expectedCache);
  }
  assert.match((await read('/assets/app-deadbeef.js')).headers['content-type'], /^text\/javascript/);
  assert.match((await read('/assets/app-deadbeef.css')).headers['content-type'], /^text\/css/);
  await writeFile(join(f.client, 'public.txt'), 'updated market file');
  assert.equal((await read('/public.txt')).body.toString(), 'updated market file', 'Public data files are refreshed after they change');
});

test('unknown routes, private build files and write methods cannot fall back to the dashboard', async t => {
  const f = await fixture(t), read = await f.start();
  for (const path of ['/unknown', '/api', '/api/unknown', '/.vite/manifest.json', '/assets/app-deadbeef.js.map', '/server/entry-server.js', '/dist/server/entry-server.js', '/entry-server.js', '/.env', '/index.html', '/index.html?monitor=hynix']) {
    const response = await read(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(!response.body.toString().includes('data-fixture'), 'An invalid route must not become an HTML app fallback');
    assert.ok(!response.body.toString().includes('SECRET') && !response.body.toString().includes('RESERVED_API_FILE'));
  }
  const post = await read('/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal(f.state.quoteReads, 0, 'Invalid routes and methods must not read market snapshots');
});

test('raw HTTP paths reject traversal, backslashes, control characters and malformed percent encoding', async t => {
  const f = await fixture(t), read = await f.start();
  for (const path of ['/assets/../public.txt', '/assets/./app-deadbeef.js', '/assets/%2e%2e/public.txt', '/assets/%2e%2e%2fpublic.txt', '/%2e%2e/dist/server/entry-server.js', '/assets/%252e%252e/public.txt', '/assets\\..\\public.txt', '/assets/%5c..%5cpublic.txt', '/assets/%00app-deadbeef.js', '/assets/%1fapp-deadbeef.js', '/assets/%7fapp-deadbeef.js', '/%2eenv']) {
    const response = await read(path);
    assert.equal(response.status, 404, path);
    assert.ok(!response.body.toString().includes('Current public market data') && !response.body.toString().includes('SECRET'), path);
  }
  for (const path of ['/%', '/%zz', '/%E0%A4%A']) assert.equal((await read(path)).status, 400, path);
  const encodedAsset = await read('/assets/%61pp-deadbeef.js');
  assert.equal(encodedAsset.status, 200, 'Benign encoded filenames remain readable');
  assert.equal(encodedAsset.body.toString(), assetText);
});

test('a symlinked public directory rejects startup instead of exposing a private directory', async t => {
  const f = await fixture(t);
  const linked = join(f.client, 'linked');
  await symlink(join(f.root, 'private'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(f.start(), /symlink|escaped build directory/i); }
  finally { await unlink(linked); }
});

test('the outer Basic gate protects both HTML and assets before page processing', async t => {
  const f = await fixture(t), read = await f.start({ authenticated: true });
  for (const path of ['/', '/assets/app-deadbeef.js', '/public.txt']) {
    for (const headers of [{}, { Authorization: 'Basic invalid-credentials' }]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await read(path, { method, headers });
        assert.equal(response.status, 401, `${method} ${path}`);
        assert.match(response.headers['www-authenticate'], /^Basic /);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.ok(!response.body.toString().includes('page-handler-fixture') && !response.body.toString().includes('revision:'));
      }
    }
  }
  assert.equal(f.state.quoteReads, 0, 'Unauthenticated requests never invoke the SSR snapshot provider');
  const page = await read('/?monitor=hynix', { headers: { Authorization: authorization } });
  assert.equal(page.status, 200);
  assert.equal(embeddedProps(page.body.toString()).initialMonitor, 'hynix');
  const asset = await read('/assets/app-deadbeef.js', { headers: { Authorization: authorization } });
  assert.equal(asset.status, 200);
  assert.equal(asset.body.toString(), assetText);
  assert.equal((await read('/assets/app-deadbeef.js', { method: 'HEAD', headers: { Authorization: authorization } })).status, 200);
});
