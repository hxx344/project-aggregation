import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAssetCompression } from '../server/portal-compression.mjs';

const publicHeaders = { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable', 'content-length': '4096', etag: '"build-one"' };
function negotiate({ method = 'GET', url = '/_next/static/chunks/page-AbCd1234.js', statusCode = 200, request = {}, source = {}, outgoing = {} } = {}) {
  const original = { ...publicHeaders, ...source };
  const headers = { ...original, ...outgoing };
  const compress = prepareAssetCompression({ method, url, headers: { 'accept-encoding': 'gzip', ...request } }, { headers: original, statusCode }, headers);
  return { compress, headers, original };
}

test('asset compression negotiates variants without stale size, range or integrity headers', () => {
  const { compress, headers, original } = negotiate({ source: { vary: 'Origin', 'accept-ranges': 'bytes', 'content-md5': 'old', digest: 'old', 'content-digest': 'old', 'repr-digest': 'old' } });
  assert.equal(compress, true);
  assert.equal(headers['content-encoding'], 'gzip');
  assert.equal(headers.vary, 'Origin, Accept-Encoding');
  assert.equal(headers.etag, 'W/"build-one"');
  for (const key of ['content-length', 'accept-ranges', 'content-md5', 'digest', 'content-digest', 'repr-digest']) assert.equal(headers[key], undefined);
  assert.equal(original['content-length'], '4096');
  assert.equal(original.etag, '"build-one"');
  assert.equal(negotiate({ method: 'HEAD' }).compress, true);
  assert.equal(negotiate({ source: { 'content-length': undefined } }).compress, true);
  assert.equal(negotiate({ source: { etag: 'W/"build-one"' } }).headers.etag, 'W/"build-one"');
  for (const vary of ['*', 'Origin, accept-encoding']) assert.equal(negotiate({ source: { vary } }).headers.vary, vary);
  for (const value of ['', 'br', 'gzip;q=0,*;q=1']) {
    const identity = negotiate({ request: { 'accept-encoding': value } });
    assert.equal(identity.compress, false);
    assert.equal(identity.headers.vary, 'Accept-Encoding');
    assert.equal(identity.headers['content-length'], '4096');
    assert.equal(identity.headers.etag, '"build-one"');
  }
});

test('private content, streams, existing encodings and range/conditional responses pass through', () => {
  for (const options of [
    { method: 'POST' }, { statusCode: 304 }, { statusCode: 206 }, { statusCode: 401 },
    { url: '/api/state' }, { url: '/' }, { url: '/assets/private.js' },
    { source: { 'content-type': 'text/event-stream' } },
    { source: { 'cache-control': 'private, immutable' } },
    { source: { 'cache-control': 'public, immutable, no-transform' } },
    { source: { 'set-cookie': ['session=private'] }, outgoing: { 'set-cookie': undefined } },
    { source: { 'content-encoding': 'br' } }, { source: { 'content-encoding': 'gzip' } },
    { source: { 'content-length': '512' } },
    { request: { range: 'bytes=0-100' } }, { request: { 'if-range': '"build-one"' } },
    { source: { 'content-range': 'bytes 0-4095/8192' } },
  ]) {
    const result = negotiate(options);
    assert.equal(result.compress, false, JSON.stringify(options));
    assert.deepEqual(result.headers, { ...result.original, ...options.outgoing });
  }
});
