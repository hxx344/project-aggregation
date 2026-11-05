import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { inspect } from 'node:util';
import { createRpc, readPoolAddresses } from '../server/research/aero-market-rpc.mjs';
import { strictMarketConfig, DEFAULT_CONFIG } from '../server/research/aero-market.mjs';

const LIMIT = 8 * 1024 * 1024;

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

// 一条恰好 bytes 字节（UTF-8）的 JSON-RPC 响应，result 由多字节字符填充：JS 字符串长度远小于字节数。
function reply(bytes, filler = '中') {
  const head = '{"jsonrpc":"2.0","id":1,"result":"', tail = '"}';
  const room = bytes - Buffer.byteLength(head + tail);
  const unit = Buffer.byteLength(filler);
  const text = head + filler.repeat(Math.floor(room / unit)) + 'a'.repeat(room % unit) + tail;
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}

// 统计大字符串进入 JSON.parse 的次数：超限的响应不能被解析。
function countLargeParses(t) {
  const parse = JSON.parse, seen = { large: 0 };
  JSON.parse = function (text, ...rest) { if (typeof text === 'string' && text.length > 1024 * 1024 && Buffer.byteLength(text) > LIMIT) seen.large++; return parse.call(this, text, ...rest); };
  t.after(() => { JSON.parse = parse; });
  return seen;
}

const call = (url) => createRpc({ url, chainId: 8453, retryDelayMs: 1 }).blockTimestamp(1).catch((error) => error);

test('rpc body limit counts decoded UTF-8 bytes: exactly the limit is read, one more byte is refused before JSON.parse', async (t) => {
  const exact = reply(LIMIT), over = reply(LIMIT + 1);
  const url = await serve(t, (req, res) => {
    const body = req.url === '/exact' ? exact : over;
    // 不带 Content-Length（分块传输），只能边读边数。
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  const seen = countLargeParses(t);
  const ok = await createRpc({ url: url + '/exact', chainId: 8453 }).blockNumber().catch((e) => e);
  // result 不是链 ID，报链 ID 不符说明恰好等于上限的响应已读完并解析。
  assert.match(ok.message, /链 ID 为 NaN/);
  const refused = await createRpc({ url: url + '/over', chainId: 8453 }).blockNumber().catch((e) => e);
  assert.ok(refused instanceof Error);
  assert.match(refused.message, /超过 8 MB/);
  assert.equal(refused.kind, 'format');
  assert.equal(seen.large, 0, 'an oversized body never reaches JSON.parse');
});

// 压缩响应的 Content-Length 只是压缩后的长度（相对解压后低报）；分块响应没有长度。
test('rpc body limit applies after gzip decoding and to a body without Content-Length', async (t) => {
  const over = gzipSync(Buffer.from(reply(LIMIT + 1)));
  const url = await serve(t, (req, res) => {
    if (req.url === '/gzip') { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': over.length }); res.end(over); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
    res.end(reply(LIMIT + 1));
  });
  const seen = countLargeParses(t);
  for (const path of ['/gzip', '/chunked']) {
    const error = await createRpc({ url: url + path, chainId: 8453 }).blockNumber().catch((e) => e);
    assert.ok(error instanceof Error, path);
    assert.match(error.message, /超过 8 MB/, path);
  }
  assert.equal(seen.large, 0);
});

test('rpc stops reading an endless body once the limit is passed', async (t) => {
  let written = 0, finished = false;
  const chunk = Buffer.alloc(256 * 1024, 0x61), total = 64 * 1024 * 1024;
  const url = await serve(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    while (written < total) {
      if (res.destroyed) return;
      const more = res.write(chunk);
      written += chunk.length;
      if (!more) await new Promise((resolve) => {
        const done = () => { res.removeListener('drain', done); res.removeListener('close', done); resolve(); };
        res.once('drain', done); res.once('close', done);
      });
    }
    finished = true; res.end();
  });
  const error = await createRpc({ url, chainId: 8453 }).blockNumber().catch((e) => e);
  assert.match(error.message, /超过 8 MB/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(finished, false, 'the client cancels the body instead of reading all 64 MB');
  assert.ok(written < total);
});

test('rpc refuses redirects without following them or retrying', async (t) => {
  let targetHits = 0, sourceHits = 0;
  const target = await serve(t, (req, res) => { targetHits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":1,"result":"0x2105"}'); });
  const source = await serve(t, (req, res) => { sourceHits++; res.writeHead(307, { location: target + '/internal?token=leak' }); res.end('moved'); });
  const error = await call(source);
  assert.ok(error instanceof Error);
  assert.equal(error.kind, 'redirect');
  assert.match(error.message, /跳转/);
  assert.doesNotMatch(error.message, /leak|internal|127\.0\.0\.1/);
  assert.equal(targetHits, 0, 'the redirect target is never contacted');
  assert.equal(sourceHits, 1, 'a redirect is not a transient failure');
});

test('rpc node errors keep the diagnosis but drop echoed URLs and secrets from the configured address', async (t) => {
  const key = 'k3yAbcdefGhijk1234567890', query = 'qs-secret-value';
  const base = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: `invalid api key ${key} for https://user:pw@rpc.example/v2/${key}?apikey=${query}\n\u001b[31mquota\u001b[0m exceeded (${query})` } }));
  });
  const error = await call(`${base}/v2/${key}?apikey=${query}`);
  assert.equal(error.kind, 'node');
  assert.match(error.message, /invalid api key/);
  assert.match(error.message, /quota/);
  for (const secret of [key, query, 'user:pw', 'rpc.example', '\u001b', '\n']) assert.ok(!error.message.includes(secret), `message leaks ${JSON.stringify(secret)}: ${error.message}`);
  assert.ok(error.message.length <= 200);
});

// 均为虚构密钥；userinfo 由低层 RPC 替身覆盖，配置入口仍拒绝带用户信息的 URL。
const encodedSecret = 'probeAlpha%2Bbeta%2Fgamma%3D';
const decodedSecret = 'probeAlpha+beta/gamma=';
const secretCases = [
  { name: 'encoded path key', url: `https://rpc.example/v2/${encodedSecret}`, echo: encodedSecret },
  { name: 'decoded path key', url: `https://rpc.example/v2/${encodedSecret}`, echo: decodedSecret },
  { name: 'mixed-case path escapes', url: `https://rpc.example/v2/${encodedSecret}`, echo: 'probeAlpha%2bbeta%2Fgamma%3d' },
  { name: 'encoded query key', url: `https://rpc.example/rpc?token=${encodedSecret}`, echo: encodedSecret },
  { name: 'decoded query key', url: `https://rpc.example/rpc?token=${encodedSecret}`, echo: decodedSecret },
  { name: 'mixed-case query escapes', url: `https://rpc.example/rpc?token=${encodedSecret}`, echo: 'probeAlpha%2Bbeta%2fgamma%3d' },
  { name: 'query plus decoded as space', url: 'https://rpc.example/rpc?token=probeAlpha+beta%2Bgamma', echo: 'probeAlpha beta+gamma' },
  { name: 'encoded username', url: `https://${encodedSecret}:password@rpc.example/rpc`, echo: encodedSecret, userinfo: true },
  { name: 'decoded username', url: `https://${encodedSecret}:password@rpc.example/rpc`, echo: decodedSecret, userinfo: true },
  { name: 'mixed-case password escapes', url: `https://user:${encodedSecret}@rpc.example/rpc`, echo: 'probeAlpha%2bbeta%2fgamma%3d', userinfo: true },
  { name: 'malformed username cannot skip the password', url: `https://bad%ZZname:${encodedSecret}@rpc.example/rpc`, echo: decodedSecret, userinfo: true },
  { name: 'malformed path remains redacted after partial decoding', url: 'https://rpc.example/rpc/probe%ZZvalue%2Bend', echo: 'probe%ZZvalue+end' },
  { name: 'short query credential', url: 'https://rpc.example/rpc?token=x%2By', echo: 'x+y' },
  { name: 'encoded control in a path credential', url: 'https://rpc.example/rpc/probe%0Aline%2Bend', echo: 'probe\nline+end' },
  { name: 'fully escaped echo', url: `https://rpc.example/rpc/${encodedSecret}`, echo: [...decodedSecret].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('') },
  { name: 'routing segment overlaps a partially encoded key', url: 'https://rpc.example/v2/probeAlphav2%2Bbeta%2Fgamma%3D', echo: 'probeAlphav2%2bbeta/gamma=' },
  { name: 'credential contains literal percent escapes', url: 'https://rpc.example/rpc/probeAlpha%252Bbeta%252Fgamma%253D', echo: encodedSecret },
  { name: 'malformed UTF-8 in a credential', url: 'https://rpc.example/rpc/probeAlpha%FF%2Bend', echo: 'probeAlpha\uFFFD+end' },
];

for (const row of secretCases) test(`rpc redacts credential variants: ${row.name}`, async () => {
  if (!row.userinfo) {
    const config = structuredClone(DEFAULT_CONFIG); config.chains.base.rpcUrl = row.url;
    assert.equal(strictMarketConfig(config).chains.base.rpcUrl, row.url);
  }
  const rpc = createRpc({ url: row.url, chainId: 8453, fetchImpl: async (_url, init) => {
    const { id } = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `quota denied: ${row.echo}` } }), { headers: { 'content-type': 'application/json' } });
  } });
  const error = await rpc.blockNumber().catch((reason) => reason);
  assert.equal(error.kind, 'node', 'malformed escapes must not break error classification');
  assert.match(error.message, /quota denied/);
  assert.ok(!error.message.includes(row.echo), 'the echoed credential must be absent');
  assert.doesNotMatch(error.message, /probeAlpha|probe%ZZvalue|probe line|x\+y/i);
});

for (const mode of ['network', 'body', 'node-code', 'result']) test(`RPC error metadata cannot carry a credential: ${mode}`, async () => {
  const url = `https://rpc.example/rpc/${encodedSecret}`;
  const rpc = createRpc({ url, chainId: 8453, retryDelayMs: 0, fetchImpl: async (_url, init) => {
    if (mode === 'network') throw new Error(`connection to ${url}: ${decodedSecret}`);
    if (mode === 'body') return new Response(new ReadableStream({ start(controller) { controller.error(new Error(decodedSecret)); } }));
    if (mode === 'result') return new Response(JSON.stringify({ result: JSON.parse(init.body).method === 'eth_chainId' ? '0x2105' : decodedSecret }));
    return new Response(JSON.stringify({ error: { code: decodedSecret, message: 'quota denied' } }));
  } });
  const error = await (mode === 'result' ? readPoolAddresses(rpc, '0x' + '1'.repeat(40)) : rpc.blockNumber()).catch((reason) => reason);
  assert.doesNotMatch(inspect(error), /probeAlpha|rpc\.example/);
  assert.equal(error.kind, mode === 'node-code' ? 'node' : mode === 'result' ? 'format' : 'network');
});

test('rpc errors from an HTTP failure or a non-JSON body never echo the response body', async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/500') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<h1>secret-backend-detail</h1>'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>secret-backend-detail</html>');
  });
  for (const path of ['/500', '/html']) {
    const error = await call(base + path);
    assert.ok(error instanceof Error, path);
    assert.doesNotMatch(error.message, /secret-backend-detail/, path);
  }
});

test('pool addresses are read in batches from the known count', async () => {
  const asked = [];
  const rpc = { async multicall(calls) {
    if (calls[0]?.fn === 'allPoolsLength') return [{ ok: true, value: 600n }];
    asked.push(calls.map((c) => c.args[0]));
    return calls.map((c) => ({ ok: true, value: `0x${c.args[0].toString(16).padStart(40, '0')}` }));
  } };
  const first = await readPoolAddresses(rpc, '0xfactory', 0, 250);
  assert.equal(first.total, 600);
  assert.equal(first.added.length, 250);
  assert.deepEqual([asked[0][0], asked[0].at(-1)], [0, 249]);
  const last = await readPoolAddresses(rpc, '0xfactory', 500, 250);
  assert.deepEqual([last.added.length, asked[1][0], asked[1].at(-1)], [100, 500, 599]);
  assert.equal((await readPoolAddresses(rpc, '0xfactory', 0)).added.length, 600, 'no limit reads all new pools');
});

test('custom RPC boundary: https to any host (including a private self-hosted node) or plain http only to this machine', () => {
  const withUrl = (rpcUrl) => { const c = structuredClone(DEFAULT_CONFIG); c.chains.base.rpcUrl = rpcUrl; return c; };
  for (const ok of ['https://10.0.0.5:8545', 'https://node.lan/rpc', 'http://127.0.0.1:8545', 'http://localhost:8545/rpc']) assert.equal(strictMarketConfig(withUrl(ok)).chains.base.rpcUrl, ok, ok);
  for (const bad of ['http://192.168.1.2:8545', 'http://10.0.0.5', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'http://user:pw@127.0.0.1:8545', 'https://user:pw@node.example', 'ftp://127.0.0.1', 'file:///etc/passwd']) {
    assert.throws(() => strictMarketConfig(withUrl(bad)), /https/, bad);
  }
});
