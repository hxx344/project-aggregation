import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { openDatabase } from '../lib/sqlite.ts';
import {
  exportTradingConnection, parseTradingExportInput, readTradingConnections,
  tradingConnectionRevision, tradingExportFailure, TradingExportError,
} from '../lib/trading-export.ts';

const key = randomBytes(32);
const password = 'synthetic-owner-password';
const credential = { exchange: 'binance', apiKey: 'synthetic-api-key-AB12', apiSecret: 'synthetic-api-secret-CD34' };
const okxCredential = { exchange: 'okx', apiKey: 'synthetic-okx-key-XY12', apiSecret: 'synthetic-okx-secret-ZW34', passphrase: 'synthetic-okx-passphrase' };
const updatedAt = '2026-10-07T04:00:00.000Z';
const now = Date.parse(updatedAt);
function seal(value: unknown, context: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('hex'), cipher: encrypted.toString('hex'), tag: cipher.getAuthTag().toString('hex') });
}
async function unseal(value: string, context: string): Promise<unknown> {
  const data = JSON.parse(value);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'hex'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.cipher, 'hex')), decipher.final()]).toString());
}
function fixture() {
  const database = openDatabase(':memory:');
  const save = async (owner = 'owner', exchange = 'binance', value: unknown = credential) => {
    const encrypted = seal(value, owner + ':' + exchange);
    await database.prepare(`INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(owner,exchange) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at`)
      .bind(owner, exchange, encrypted, updatedAt).run();
    return { exchange, revision: tradingConnectionRevision(encrypted), password };
  };
  const dependencies = { unseal, verifyPassword: async (input: string) => input === password, now: () => now };
  return { database, save, dependencies };
}

test('managed export requires an explicit server authorization while retaining revision and owner checks', async () => {
  const { database, save, dependencies } = fixture();
  try {
    const { password: ignored, ...input } = await save();
    assert.ok(ignored);
    await assert.rejects(exportTradingConnection(database, 'owner', input, dependencies), /输入格式不正确/);
    const managed = { ...dependencies, workspaceAuthorized: true, verifyPassword: async () => { assert.fail('managed export asked for a separate password'); } };
    const exported = await exportTradingConnection(database, 'owner', input, managed);
    assert.deepEqual(exported.credentials, { apiKey: credential.apiKey, apiSecret: credential.apiSecret });
    await assert.rejects(exportTradingConnection(database, 'other-owner', input, managed), /连接已变更/);
    await save('owner', 'binance', { ...credential, apiKey: 'updated-synthetic-key' });
    await assert.rejects(exportTradingConnection(database, 'owner', input, managed), /连接已变更/);
  } finally { database.close(); }
});
function status(expected: number) {
  return (error: unknown) => error instanceof TradingExportError && error.status === expected;
}

test('legacy catalog has exactly two owner-scoped rows and never unseals an OKX or Aster connection', async () => {
  const { database, save } = fixture();
  try {
    const input = await save();
    await save('other', 'bybit', { ...credential, exchange: 'bybit', region: 'global' });
    await save('owner', 'okx', okxCredential);
    await save('owner', 'aster', { exchange: 'aster', privateKey: 'must-never-be-read' });
    await database.prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?)').bind('owner', 'binance-status', '{"label":"untrusted-full-key"}').run();
    const calls: string[] = [];
    const catalog = await readTradingConnections(database, 'owner', async (encrypted, context) => {
      calls.push(context); return unseal(encrypted, context);
    }, { includeOkx: false });
    assert.deepEqual(calls, ['owner:binance']);
    assert.deepEqual(catalog, { schemaVersion: 1, connections: [
      { exchange: 'binance', configured: true, revision: input.revision, label: 'AB12', updatedAt, supported: true, reason: null },
      { exchange: 'bybit', configured: false, revision: null, label: null, updatedAt: null, supported: true, reason: null },
    ] });
    const text = JSON.stringify(catalog);
    for (const secret of [credential.apiKey, credential.apiSecret, okxCredential.apiKey, okxCredential.apiSecret, okxCredential.passphrase, 'must-never-be-read', 'untrusted-full-key']) assert.equal(text.includes(secret), false);
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM assets').first<{ count: number }>())?.count, 0);
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM snapshots').first<{ count: number }>())?.count, 0);
  } finally { database.close(); }
});

test('extended catalog includes OKX owner metadata without key, secret or passphrase fields', async () => {
  const { database, save } = fixture();
  try {
    const input = await save('owner', 'okx', okxCredential);
    await save('other', 'binance');
    await save('other', 'okx', { ...okxCredential, passphrase: 'other-owner-passphrase' });
    const calls: string[] = [];
    const catalog = await readTradingConnections(database, 'owner', async (encrypted, context) => {
      calls.push(context); return unseal(encrypted, context);
    });
    assert.equal(catalog.schemaVersion, 1);
    assert.deepEqual(catalog.connections.map(row => row.exchange), ['binance', 'bybit', 'okx']);
    assert.deepEqual(calls, ['owner:okx']);
    assert.equal(catalog.connections[0].configured, false);
    assert.deepEqual(catalog.connections[2], {
      exchange: 'okx', configured: true, revision: input.revision, label: 'XY12', updatedAt, supported: true, reason: null,
    });
    assert.deepEqual(await readTradingConnections(database, 'owner', unseal, { includeOkx: true }), catalog);
    for (const secret of [...Object.values(okxCredential).filter(value => value !== 'okx'), 'other-owner-passphrase', 'apiKey', 'apiSecret', 'passphrase']) {
      assert.equal(JSON.stringify(catalog).includes(secret), false);
    }
  } finally { database.close(); }
});

test('export requires password and matching owner, and returns only the exact global contract', async () => {
  const { database, save, dependencies } = fixture();
  try {
    const input = await save();
    await assert.rejects(exportTradingConnection(database, 'owner', { exchange: input.exchange, revision: input.revision }, dependencies), status(400));
    await assert.rejects(exportTradingConnection(database, 'owner', { ...input, password: 'wrong-password' }, dependencies), status(401));
    await assert.rejects(exportTradingConnection(database, 'other', input, dependencies), status(409));
    assert.deepEqual(await exportTradingConnection(database, 'owner', input, dependencies), {
      schemaVersion: 1, exchange: 'binance', revision: input.revision, region: 'global',
      credentials: { apiKey: credential.apiKey, apiSecret: credential.apiSecret },
    });
    const bybit = { ...credential, exchange: 'bybit', region: 'global' };
    const bybitInput = await save('owner', 'bybit', bybit);
    assert.equal((await exportTradingConnection(database, 'owner', bybitInput, dependencies)).region, 'global');
    const okxInput = await save('owner', 'okx', okxCredential);
    assert.deepEqual(await exportTradingConnection(database, 'owner', okxInput, dependencies), {
      schemaVersion: 1, exchange: 'okx', revision: okxInput.revision, region: 'global',
      credentials: { apiKey: okxCredential.apiKey, apiSecret: okxCredential.apiSecret, passphrase: okxCredential.passphrase },
    });
  } finally { database.close(); }
});

test('strict export input rejects Aster, extra fields, malformed revisions, and invalid passwords', () => {
  const input = { exchange: 'binance', revision: 'a'.repeat(64), password };
  for (const invalid of [null, [], {}, { ...input, exchange: 'aster' }, { ...input, owner: 'other' },
    { ...input, region: 'global' }, { ...input, revision: 'g'.repeat(64) }, { ...input, password: '' },
    { ...input, password: 1 }, { ...input, password: 'p'.repeat(257) }]) {
    assert.throws(() => parseTradingExportInput(invalid), status(400));
  }
  assert.equal(parseTradingExportInput({ ...input, revision: 'A'.repeat(64) }).revision, 'a'.repeat(64));
  assert.equal(parseTradingExportInput({ ...input, exchange: 'okx' }).exchange, 'okx');
});

test('OKX passphrase validation rejects malformed vaults without secret echoes or metadata leakage', async () => {
  const { database, save, dependencies } = fixture();
  try {
    const values = [
      { ...okxCredential, passphrase: undefined }, { ...okxCredential, passphrase: '' },
      { ...okxCredential, passphrase: 'short' }, { ...okxCredential, passphrase: 'x'.repeat(129) },
      { ...okxCredential, passphrase: 'synthetic\npassphrase' }, { ...okxCredential, passphrase: 'synthetic\u007fpassphrase' },
      { ...okxCredential, passphrase: 'synthetic\u0080passphrase' }, { ...okxCredential, passphrase: 12345678 },
      { ...okxCredential, region: 'us' }, { ...okxCredential, exchange: 'bybit' },
      { ...okxCredential, privateKey: 'must-not-be-accepted' }, { ...okxCredential, apiSecret: 'malformed secret' },
    ];
    for (const value of values) {
      const input = await save('owner', 'okx', value);
      const metadata = (await readTradingConnections(database, 'owner', unseal)).connections[2];
      assert.deepEqual(metadata, { exchange: 'okx', configured: false, revision: null, label: null, updatedAt: null, supported: false, reason: 'Asset 连接无法用于导入，请在 Asset 重新保存连接' });
      await assert.rejects(exportTradingConnection(database, 'owner', input, dependencies), error => status(409)(error) && !String(error).includes(okxCredential.apiSecret));
    }
  } finally { database.close(); }
});

test('OKX export rechecks password, owner and revision before returning any passphrase', async () => {
  const { database, save, dependencies } = fixture();
  try {
    const input = await save('owner', 'okx', okxCredential);
    const noUnseal = { ...dependencies, unseal: async () => { assert.fail('Rejected export must not unseal the OKX passphrase'); } };
    await assert.rejects(exportTradingConnection(database, 'other', input, noUnseal), status(409));
    await assert.rejects(exportTradingConnection(database, 'owner', { ...input, password: 'wrong-password' }, noUnseal), status(401));
    await assert.rejects(exportTradingConnection(database, 'owner', input, {
      ...dependencies,
      unseal: async (encrypted, context) => {
        const result = await unseal(encrypted, context);
        await save('owner', 'okx', { ...okxCredential, passphrase: 'replacement-passphrase' });
        return result;
      },
    }), status(409));
    await assert.rejects(exportTradingConnection(database, 'owner', input, noUnseal), status(409));
  } finally { database.close(); }
});

test('unsupported regions, stored exchange mismatch and malformed credentials cannot be selected or exported', async () => {
  const { database, save, dependencies } = fixture();
  try {
    const values = [
      { exchange: 'bybit', value: { ...credential, exchange: 'bybit', region: 'eu' } },
      { exchange: 'bybit', value: { ...credential, exchange: 'bybit' } },
      { exchange: 'binance', value: { ...credential, region: 'us' } },
      { exchange: 'binance', value: { ...credential, exchange: 'aster' } },
      { exchange: 'binance', value: { ...credential, apiKey: 'short' } },
      { exchange: 'binance', value: { ...credential, apiSecret: 'key with spaces' } },
      { exchange: 'binance', value: { ...credential, apiSecret: 'a'.repeat(513) } },
      { exchange: 'binance', value: { ...credential, privateKey: 'must-not-be-accepted' } },
    ];
    for (const { exchange, value } of values) {
      const input = await save('owner', exchange, value);
      const entry = (await readTradingConnections(database, 'owner', unseal)).connections.find(item => item.exchange === exchange)!;
      assert.equal(entry.configured, false);
      assert.equal(entry.supported, false);
      assert.equal(entry.revision, null);
      assert.equal(entry.label, null);
      assert.ok(entry.reason);
      if ('region' in value) assert.match(entry.reason, /global/);
      await assert.rejects(exportTradingConnection(database, 'owner', input, dependencies), status(409));
    }
  } finally { database.close(); }
});

test('corrupt vaults and wrong encryption owner fail safely without crypto or credential echoes', async () => {
  const { database, save, dependencies } = fixture();
  try {
    await save();
    for (const encrypted of ['not-json-' + credential.apiSecret, seal(credential, 'other:binance')]) {
      await database.prepare("UPDATE connections SET encrypted = ? WHERE owner = 'owner' AND exchange = 'binance'").bind(encrypted).run();
      const catalog = await readTradingConnections(database, 'owner', unseal);
      assert.equal(catalog.connections[0].configured, false);
      assert.equal(catalog.connections[0].supported, false);
      assert.equal(JSON.stringify(catalog).includes(credential.apiSecret), false);
      await assert.rejects(exportTradingConnection(database, 'owner', {
        exchange: 'binance', revision: tradingConnectionRevision(encrypted), password,
      }, dependencies), error => status(409)(error) && !String(error).includes(credential.apiSecret));
    }
    assert.deepEqual(tradingExportFailure(new Error(credential.apiSecret)), { error: 'Asset 连接服务暂不可用，请稍后重试', status: 503 });
  } finally { database.close(); }
});

test('stale revision rejects before verifying password or decrypting', async () => {
  const { database, save, dependencies } = fixture();
  try {
    const input = await save();
    await save();
    await assert.rejects(exportTradingConnection(database, 'owner', input, {
      ...dependencies,
      verifyPassword: async () => { assert.fail('A stale source must not verify a password'); },
      unseal: async () => { assert.fail('A stale source must not be unsealed'); },
    }), status(409));
    assert.equal(await database.prepare('SELECT attempts FROM auth_attempts').first(), null);
  } finally { database.close(); }
});

test('source rotation during password verification rejects before decrypting', async () => {
  const { database, save, dependencies } = fixture();
  try {
    const input = await save();
    await assert.rejects(exportTradingConnection(database, 'owner', input, {
      ...dependencies,
      verifyPassword: async () => { await save(); return true; },
      unseal: async () => { assert.fail('Rotated source must not be unsealed'); },
    }), status(409));
  } finally { database.close(); }
});

test('source rotation or deletion during unseal rejects instead of exporting a superseded snapshot', async () => {
  const { database, save, dependencies } = fixture();
  try {
    for (const remove of [false, true]) {
      const input = await save();
      await assert.rejects(exportTradingConnection(database, 'owner', input, {
        ...dependencies,
        unseal: async (encrypted, context) => {
          const result = await unseal(encrypted, context);
          if (remove) await database.prepare("DELETE FROM connections WHERE owner = 'owner' AND exchange = 'binance'").run();
          else await save();
          return result;
        },
      }), status(409));
    }
  } finally { database.close(); }
});

test('password limit is persisted, owner-scoped, shared across exchanges, and expires after 15 minutes', async () => {
  const { database, save, dependencies } = fixture();
  try {
    const input = await save();
    const bybitInput = await save('owner', 'bybit', { ...credential, exchange: 'bybit', region: 'global' });
    const okxInput = await save('owner', 'okx', okxCredential);
    for (let attempt = 0; attempt < 5; attempt++) {
      await assert.rejects(exportTradingConnection(database, 'owner', { ...input, password: 'wrong-password' }, dependencies), status(401));
    }
    await assert.rejects(exportTradingConnection(database, 'owner', bybitInput, {
      ...dependencies, verifyPassword: async () => { assert.fail('Limit checked before expensive verification'); },
    }), status(429));
    await assert.rejects(exportTradingConnection(database, 'owner', okxInput, {
      ...dependencies, verifyPassword: async () => { assert.fail('OKX shares the same owner password limit'); },
    }), status(429));
    assert.deepEqual({ ...await database.prepare('SELECT id,attempts FROM auth_attempts').first() }, { id: 'hub-trading-export:owner', attempts: 5 });
    const otherInput = await save('other');
    assert.equal((await exportTradingConnection(database, 'other', otherInput, dependencies)).schemaVersion, 1);
    assert.equal((await exportTradingConnection(database, 'owner', input, { ...dependencies, now: () => now + 15 * 60_000 })).schemaVersion, 1);
  } finally { database.close(); }
});

test('parallel reservations are bounded and a successful verification cannot erase concurrent failures', async () => {
  const { database, save, dependencies } = fixture();
  try {
    const input = await save();
    const pending: ((value: boolean) => void)[] = [];
    const concurrentDependencies = {
      ...dependencies, verifyPassword: () => new Promise<boolean>(resolve => { pending.push(resolve); }),
    };
    const calls = Array.from({ length: 6 }, () => exportTradingConnection(database, 'owner', input, concurrentDependencies));
    const settled = Promise.allSettled(calls);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 5);
    assert.equal((await database.prepare('SELECT attempts FROM auth_attempts').first<{ attempts: number }>())?.attempts, 5);
    pending[0](true);
    for (const finish of pending.slice(1)) finish(false);
    const results = await settled;
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && status(401)(result.reason)).length, 4);
    assert.equal(results.filter(result => result.status === 'rejected' && status(429)(result.reason)).length, 1);
    assert.equal((await database.prepare('SELECT attempts FROM auth_attempts').first<{ attempts: number }>())?.attempts, 4);
    await assert.rejects(exportTradingConnection(database, 'owner', { ...input, password: 'wrong-password' }, dependencies), status(401));
    await assert.rejects(exportTradingConnection(database, 'owner', input, dependencies), status(429));
  } finally { database.close(); }
});

test('a successful attempt from an expired window cannot refund a newer window failure', async () => {
  const { database, save, dependencies } = fixture();
  try {
    const input = await save();
    let finish!: (valid: boolean) => void;
    const original = exportTradingConnection(database, 'owner', input, {
      ...dependencies, verifyPassword: () => new Promise<boolean>(resolve => { finish = resolve; }),
    });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(exportTradingConnection(database, 'owner', { ...input, password: 'wrong-password' }, {
      ...dependencies, now: () => now + 15 * 60_000,
    }), status(401));
    finish(true);
    await original;
    assert.equal((await database.prepare('SELECT attempts FROM auth_attempts').first<{ attempts: number }>())?.attempts, 1);
  } finally { database.close(); }
});
