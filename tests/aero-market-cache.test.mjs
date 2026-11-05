import assert from 'node:assert/strict';
import test from 'node:test';

// Minimal IndexedDB stand-in: one database, one object store, asynchronous request callbacks.
const rows = new Map();
globalThis.indexedDB = {
  open() {
    const request = {};
    const db = {
      transaction() {
        return { objectStore: () => ({
          get(key) { const get = {}; setTimeout(() => { get.result = rows.get(key); get.onsuccess?.(); }); return get; },
          delete(key) { rows.delete(key); },
        }) };
      },
    };
    setTimeout(() => { request.result = db; request.onsuccess?.(); });
    return request;
  },
};
const { readCache } = await import('../src/aero-market-cache.ts');
const DAY = 86_400_000;

test('a fresh entry is returned and kept', async () => {
  rows.set('fresh', { schema: 1, savedAt: Date.now() - DAY, data: { ok: true } });
  assert.deepEqual((await readCache('fresh'))?.data, { ok: true });
  assert.ok(rows.has('fresh'));
});

test('expired or foreign-schema entries are deleted, not just hidden', async () => {
  // Older builds cached node diagnostics that may echo an RPC key.
  rows.set('expired', { schema: 1, savedAt: Date.now() - 8 * DAY, data: { error: 'https://rpc.example/secret' } });
  rows.set('schema', { schema: 0, savedAt: Date.now(), data: {} });
  rows.set('broken', { schema: 1, savedAt: Number.NaN, data: {} });
  for (const key of ['expired', 'schema', 'broken']) {
    assert.equal(await readCache(key), null, key);
    assert.equal(rows.has(key), false, key);
  }
  assert.equal(await readCache('missing'), null);
});
