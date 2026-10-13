import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Run after building modules/asset. Every run owns a fresh data directory and
// child process; production routes execute with synthetic credentials only.
const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../modules/asset/', import.meta.url));
const child = process.argv[2] === '--child';
if (!child) {
  assert.ok(existsSync(join(root, '.next/required-server-files.json')), 'Build modules/asset before running this smoke test');
  const temporaryRoot = realpathSync(tmpdir());
  const dataDir = mkdtempSync(join(temporaryRoot, 'asset-gate-smoke-'));
  // Deliberately exclude NODE_OPTIONS, API credentials, workspace secrets and
  // existing ASSET_* settings inherited from a developer or CI environment.
  const allowedEnvironment = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile', 'localappdata', 'appdata', 'comspec', 'pathext', 'number_of_processors', 'processor_architecture', 'lang', 'lc_all']);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toLowerCase())));
  try {
    const result = spawnSync(process.execPath, [script, '--child', dataDir], {
      env: { ...environment, ASSET_DATA_DIR: dataDir, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
      stdio: 'inherit', windowsHide: true, timeout: 120_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Gate production smoke child failed (${result.signal ?? 'exit'})`);
  } finally {
    const resolved = realpathSync(dataDir);
    const location = relative(temporaryRoot, resolved);
    assert.ok(location && !location.startsWith('..') && !isAbsolute(location) && basename(resolved).startsWith('asset-gate-smoke-'), 'Cleanup must stay inside this test temporary root');
    rmSync(resolved, { recursive: true, force: true });
  }
  process.exit(0);
}

const dataDir = resolve(process.argv[3]);
assert.equal(resolve(process.env.ASSET_DATA_DIR), dataDir);
const gateUrl = 'https://api.gateio.ws/api/v4/wallet/total_balance?currency=USD';
const credentials = { exchange: 'gate', apiKey: 'synthetic-gate-key', apiSecret: 'synthetic-gate-secret' };
const replacement = { exchange: 'gate', apiKey: 'synthetic-gate-key-replacement', apiSecret: 'synthetic-gate-secret-replacement' };
const secrets = [credentials.apiKey, credentials.apiSecret, replacement.apiKey, replacement.apiSecret];
const sensitiveDetails = secrets.join(' ') + ' signature=private-signature https://evil.example signed-request';
const emptyHash = createHash('sha512').update('').digest('hex');
const payload = {
  total: { amount: '125.50', currency: 'USD' },
  details: { spot: { amount: '100', currency: 'USD' }, futures: { amount: '25.50', currency: 'USD' } },
};
let gateFailure = null;
let gateCalls = 0;
let externalFailures = 0;
const transportViolations = [];

// No fallback to native fetch: every non-Gate external request fails locally.
// Record assertion failures separately because production readers sanitize them.
globalThis.fetch = async (input, init = {}) => {
  try {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const headers = new Headers(init.headers ?? request?.headers);
    const method = init.method ?? request?.method ?? 'GET';
    if (url.hostname !== 'api.gateio.ws') {
      assert.equal(headers.get('KEY'), null, 'Gate credentials must not reach quote providers');
      assert.equal(headers.get('SIGN'), null, 'Gate signatures must not reach quote providers');
      for (const secret of secrets) assert.ok(!url.href.includes(secret), 'Credentials must not appear in a request URL');
      externalFailures++;
      return new Response('', { status: 503 });
    }
    gateCalls++;
    assert.equal(url.href, gateUrl, 'Gate must use only the total-balance endpoint');
    assert.equal(method, 'GET');
    assert.equal(init.redirect ?? request?.redirect, 'manual');
    assert.equal(init.body ?? request?.body ?? undefined, undefined);
    assert.equal(headers.get('Accept'), 'application/json');
    assert.equal(headers.get('Content-Type'), 'application/json');
    const apiKey = headers.get('KEY');
    const signedWith = apiKey === replacement.apiKey ? replacement : credentials;
    assert.equal(apiKey, signedWith.apiKey);
    const timestamp = headers.get('Timestamp');
    assert.match(timestamp, /^\d+$/);
    assert.ok(Math.abs(Date.now() - Number(timestamp) * 1000) < 30_000);
    const expected = createHmac('sha512', signedWith.apiSecret)
      .update(['GET', '/api/v4/wallet/total_balance', 'currency=USD', emptyHash, timestamp].join('\n')).digest('hex');
    assert.equal(headers.get('SIGN'), expected, 'Sign the exact method, path, query, empty payload hash and timestamp');
    for (const secret of secrets) assert.ok(!url.href.includes(secret));
    // Return a rejected promise without awaiting it so this intentional transport
    // failure does not enter the assertion-violation catch below.
    if (gateFailure === 'dns') return Promise.reject(new Error('fetch failed ' + sensitiveDetails, { cause: { code: 'ENOTFOUND', message: sensitiveDetails } }));
    if (gateFailure) {
      const options = { status: gateFailure.status, headers: gateFailure.headers };
      if (gateFailure.readFailed) return new Response(new ReadableStream({ pull(controller) { controller.error(new Error(sensitiveDetails)); } }), options);
      if (Object.hasOwn(gateFailure, 'body')) return new Response(gateFailure.body, options);
      return Response.json({ label: gateFailure.label, message: sensitiveDetails, detail: sensitiveDetails }, options);
    }
    return Response.json(payload);
  } catch (error) {
    transportViolations.push(error);
    throw error;
  }
};

const { createModule } = await import('../server/modules/asset.mjs');
const workspaceSecret = randomUUID();
const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\asset-gate-smoke-${randomUUID()}` : join(dataDir, 'app.sock');
const previousCwd = process.cwd();
let module;
let database;
let owner;

function noCredentials(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!serialized.includes(secret), 'Public responses and stored metadata must not contain credentials');
  assert.doesNotMatch(serialized, /"(?:apiKey|apiSecret|encrypted)"\s*:/);
  assert.doesNotMatch(serialized, /private-signature|evil\.example|signed-request/);
}

function request(path, { method = 'GET', body } = {}) {
  return new Promise((resolveRequest, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ socketPath, path, method, agent: false, headers: {
      host: 'asset.workspace.internal', 'x-workspace-key': workspaceSecret,
      ...(method === 'GET' ? {} : { origin: 'http://asset.workspace.internal', 'content-type': 'application/json' }),
      ...(data === undefined ? {} : { 'content-length': Buffer.byteLength(data) }),
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString();
          noCredentials(text);
          resolveRequest({ status: response.statusCode, data: JSON.parse(text) });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('Local Gate smoke request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

async function success(path, options) {
  const response = await request(path, options);
  assert.equal(response.status, 200, `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(response.data)}`);
  return response.data;
}

async function rejected(path, options) {
  const response = await request(path, options);
  assert.ok(response.status >= 400 && response.status < 600, `${path} should reject this operation`);
  assert.equal(typeof response.data.error, 'string');
  return response.data;
}

function gateRows(ledger) { return ledger.assets.filter(asset => asset.mode === 'gate'); }
function gateAsset(ledger) {
  assert.equal(gateRows(ledger).length, 1, 'Gate contributes exactly one asset row');
  return gateRows(ledger)[0];
}
function storedCredential() {
  return database.prepare('SELECT encrypted,updated_at FROM connections WHERE owner = ? AND exchange = ?').get(owner, 'gate');
}
function storedAssets() {
  return database.prepare('SELECT id,data FROM assets WHERE owner = ? ORDER BY id').all(owner);
}
function clearRefreshThrottle() {
  database.prepare('DELETE FROM settings WHERE owner = ? AND key = ?').run(owner, 'last-attempt');
}
function balanceUnchanged(actual, expected) {
  for (const key of ['id', 'quantity', 'price', 'value', 'details', 'updatedAt']) assert.deepEqual(actual[key], expected[key], `Preserve Gate ${key}`);
}
function assertBalance(asset, since) {
  assert.equal(asset.value, 125.5);
  assert.equal(asset.quantity, 125.5);
  assert.equal(asset.price, 1);
  assert.ok(!asset.error);
  assert.ok(Date.parse(asset.updatedAt) >= since && Date.parse(asset.updatedAt) <= Date.now(), 'Use local retrieval time');
  assert.equal(asset.details.length, 2);
  assert.deepEqual(asset.details.map(detail => detail.value).sort((a, b) => a - b), [25.5, 100]);
  for (const detail of asset.details) {
    assert.equal(detail.coin, 'USD');
    assert.equal(detail.quantity, detail.value);
    assert.equal(detail.price, 1);
  }
}

try {
  process.chdir(root);
  module = await createModule({ root, dataDir, secret: workspaceSecret });
  await new Promise((resolveListen, reject) => {
    module.server.once('error', reject);
    module.server.listen(socketPath, resolveListen);
  });
  const initial = await success('/api/ledger');
  assert.equal(gateRows(initial).length, 0);
  assert.equal(initial.connections.gate.configured, false);
  database = new DatabaseSync(join(dataDir, 'ledger.sqlite'));
  database.exec('PRAGMA busy_timeout = 5000');
  const owners = database.prepare('SELECT DISTINCT owner FROM settings WHERE key = ?').all('initialized');
  assert.equal(owners.length, 1);
  owner = owners[0].owner;
  assert.equal(owner, 'owner', 'Managed Asset signs the owner session');
  const originalAssets = storedAssets();

  let expectedGateCalls = 0;
  for (const [failure, checks] of [
    [{ status: 403, label: 'IP_FORBIDDEN' }, [/HTTP 403/, /IP_FORBIDDEN/, /服务器.*出口/, /白名单/]],
    [{ status: 400, label: 'INVALID_CONTENT_TYPE' }, [/HTTP 400/, /INVALID_CONTENT_TYPE/, /Content-Type|内容类型/]],
    [{ status: 400, label: sensitiveDetails }, [/HTTP 400/, /API_CODE_UNKNOWN/]],
    [{ status: 400, body: JSON.stringify({ message: sensitiveDetails }) }, [/HTTP 400/, /API_CODE_MISSING/]],
    [{ status: 400, body: '' }, [/HTTP 400/, /RESPONSE_EMPTY/]],
    [{ status: 400, body: '<html>' + sensitiveDetails, headers: { 'content-type': 'text/html; charset=' + sensitiveDetails } }, [/HTTP 400/, /RESPONSE_HTML/]],
    [{ status: 400, body: sensitiveDetails }, [/HTTP 400/, /RESPONSE_NON_JSON/]],
    [{ status: 400, body: sensitiveDetails, headers: { 'content-length': String(16 * 1024 + 1) } }, [/HTTP 400/, /RESPONSE_TOO_LARGE/]],
    [{ status: 400, readFailed: true }, [/HTTP 400/, /RESPONSE_READ_FAILED/]],
    ['dns', [/DNS.*解析|解析.*DNS/, /检查|重试/]],
  ]) {
    gateFailure = failure;
    const diagnostic = await rejected('/api/connections', { method: 'POST', body: credentials });
    assert.match(diagnostic.error, /^Gate 读取失败/, 'Detailed diagnostics must survive the production API failure filter');
    assert.match(diagnostic.error, /本次未更新资产数据/);
    for (const check of checks) assert.match(diagnostic.error, check);
    if (failure === 'dns') assert.doesNotMatch(diagnostic.error, /HTTP|ENOTFOUND|fetch failed/);
    assert.equal(gateCalls, ++expectedGateCalls);
    assert.equal(storedCredential(), undefined, 'First failure must not save credentials');
    assert.deepEqual(storedAssets(), originalAssets, 'First failure must not create an asset');
    const failedLedger = await success('/api/ledger');
    assert.equal(failedLedger.connections.gate.configured, false);
    assert.equal(failedLedger.connections.gate.lastSync, null);
  }

  gateFailure = null;
  let since = Date.now();
  let ledger = await success('/api/connections', { method: 'POST', body: credentials });
  assert.equal(gateCalls, ++expectedGateCalls);
  let asset = gateAsset(ledger);
  assertBalance(asset, since);
  assert.equal(ledger.assets.length, initial.assets.length + 1);
  assert.equal(ledger.connections.gate.configured, true);
  const createdId = asset.id;
  const sealed = JSON.parse(storedCredential().encrypted);
  assert.equal(sealed.iv.length, 12);
  assert.ok(sealed.cipher.length > 16);
  for (const secret of secrets) assert.ok(!storedCredential().encrypted.includes(secret));
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  const key = await crypto.subtle.importKey('raw', Buffer.from(config.credentialKey, 'hex'), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(sealed.iv), additionalData: new TextEncoder().encode(owner + ':gate') }, key, new Uint8Array(sealed.cipher));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), credentials, 'Credentials use the configured authenticated encryption');
  for (const row of database.prepare('SELECT value FROM settings WHERE owner = ?').all(owner)) noCredentials(row.value);

  ledger = await success('/api/connections', { method: 'POST', body: credentials });
  assert.equal(gateCalls, ++expectedGateCalls);
  asset = gateAsset(ledger);
  assert.equal(asset.id, createdId);
  assert.equal(ledger.assets.length, initial.assets.length + 1, 'Saving again must not duplicate Gate');
  await rejected('/api/ledger', { method: 'PATCH', body: { id: asset.id, quantity: 999, price: 1 } });
  balanceUnchanged(gateAsset(await success('/api/ledger')), asset);

  const savedConnection = storedCredential();
  const lastSync = ledger.connections.gate.lastSync;
  for (const [failure, checks] of [
    [{ status: 403, label: 'FORBIDDEN' }, [/HTTP 403.*FORBIDDEN/, /钱包.*读取/]],
    [{ status: 400, label: 'INVALID_CONTENT_TYPE' }, [/HTTP 400.*INVALID_CONTENT_TYPE/]],
    [{ status: 400, label: sensitiveDetails }, [/HTTP 400.*API_CODE_UNKNOWN/]],
  ]) {
    gateFailure = failure;
    const replacementError = await rejected('/api/connections', { method: 'POST', body: replacement });
    for (const check of checks) assert.match(replacementError.error, check);
    assert.equal(gateCalls, ++expectedGateCalls);
    assert.deepEqual(storedCredential(), savedConnection, 'Failed replacement must preserve the previous encrypted credentials');
    const afterReplacementFailure = await success('/api/ledger');
    balanceUnchanged(gateAsset(afterReplacementFailure), asset);
    assert.equal(afterReplacementFailure.connections.gate.lastSync, lastSync);
  }

  for (const [failure, checks] of [
    [{ status: 403, label: 'INVALID_SIGNATURE' }, [/HTTP 403.*INVALID_SIGNATURE/, /同一组|配对/]],
    [{ status: 400, label: 'BAD_REQUEST' }, [/HTTP 400.*BAD_REQUEST/]],
    [{ status: 400, body: '<html>' + sensitiveDetails }, [/HTTP 400.*RESPONSE_HTML/]],
  ]) {
    gateFailure = failure;
    clearRefreshThrottle();
    ledger = await success('/api/sync', { method: 'POST', body: {} });
    assert.equal(gateCalls, ++expectedGateCalls);
    balanceUnchanged(gateAsset(ledger), asset);
    assert.match(gateAsset(ledger).status, /失败.*旧值/);
    for (const check of checks) assert.match(gateAsset(ledger).error, check);
    assert.equal(gateAsset(ledger).error, ledger.connections.gate.error);
    assert.equal(ledger.connections.gate.lastSync, lastSync, 'Failed refresh must preserve the last successful sync time');
    assert.deepEqual(storedCredential(), savedConnection);
  }

  gateFailure = null;
  clearRefreshThrottle();
  const beforeQuoteFailures = externalFailures;
  since = Date.now();
  ledger = await success('/api/sync', { method: 'POST', body: {} });
  assert.equal(gateCalls, ++expectedGateCalls);
  asset = gateAsset(ledger);
  assertBalance(asset, since);
  assert.equal(ledger.connections.gate.error, null);
  assert.ok(externalFailures > beforeQuoteFailures, 'The refresh must exercise failing external quotes');
  assert.ok(ledger.assets.find(row => row.mode === 'market').error);
  assert.ok(ledger.fxStatus.error);

  ledger = await success('/api/connections', { method: 'DELETE', body: { exchange: 'gate' } });
  balanceUnchanged(gateAsset(ledger), asset);
  assert.equal(ledger.connections.gate.configured, false);
  assert.equal(storedCredential(), undefined);
  assert.match(gateAsset(ledger).status, /断开.*旧值/);
  assert.equal(gateCalls, expectedGateCalls);

  // Old ledgers may contain either alias as a manual row. Set up that legacy
  // state directly; exercise adoption through the real connection endpoint.
  for (const project of ['Gate', ' Gate.io ']) {
    const manual = { ...gateAsset(ledger), project, mode: 'manual', quantity: 42, price: 1, value: 42, status: '手动估值' };
    delete manual.details;
    delete manual.error;
    database.prepare('UPDATE assets SET data = ? WHERE owner = ? AND id = ?').run(JSON.stringify(manual), owner, manual.id);
    ledger = await success('/api/ledger');
    assert.equal(ledger.assets.find(row => row.id === manual.id).mode, 'manual');
    ledger = await success('/api/connections', { method: 'POST', body: credentials });
    assert.equal(gateCalls, ++expectedGateCalls);
    assert.equal(gateAsset(ledger).id, manual.id, 'Adopt the existing manual alias row');
    assert.equal(ledger.assets.length, initial.assets.length + 1);
    assert.equal(gateAsset(ledger).value, 125.5);
    ledger = await success('/api/connections', { method: 'DELETE', body: { exchange: 'gate' } });
  }

  const manual = { ...gateAsset(ledger), project: 'Gate', mode: 'manual' };
  const duplicate = { ...manual, id: 'row-900001', cell: 'E900001', project: 'Gate.io' };
  database.prepare('UPDATE assets SET data = ? WHERE owner = ? AND id = ?').run(JSON.stringify(manual), owner, manual.id);
  database.prepare('INSERT INTO assets(owner,id,data) VALUES(?,?,?)').run(owner, duplicate.id, JSON.stringify(duplicate));
  const duplicatedAssets = storedAssets();
  const duplicateError = await rejected('/api/connections', { method: 'POST', body: credentials });
  assert.match(duplicateError.error, /多条|重复/);
  assert.equal(gateCalls, expectedGateCalls, 'Reject duplicate aliases before requesting balances');
  assert.equal(storedCredential(), undefined);
  assert.deepEqual(storedAssets(), duplicatedAssets);
  database.prepare('DELETE FROM assets WHERE owner = ? AND id = ?').run(owner, duplicate.id);
  ledger = await success('/api/connections', { method: 'POST', body: credentials });
  assert.equal(gateCalls, ++expectedGateCalls);
  asset = gateAsset(ledger);
  const beforeImportConnection = storedCredential();

  const source = JSON.parse(readFileSync(join(root, 'lib/example-ledger.json'), 'utf8'));
  source.source = 'Gate 生命周期测试原表';
  const baseline = source.periods.find(period => period.id === source.baselineId);
  baseline.rows.push({ id: 'row-900', project: 'Gate.io', kind: '资产', quantity: 1, price: 1, value: 1, cell: 'E900' });
  baseline.total += 1;
  baseline.rowSum = baseline.total;
  baseline.cny = baseline.total * baseline.fx;
  const preview = await success('/api/import', { method: 'POST', body: { source, apply: false } });
  assert.ok(preview.summary.retained.some(label => /Gate.*已同步余额/.test(label)));
  balanceUnchanged(gateAsset(await success('/api/ledger')), asset);
  const imported = await success('/api/import', { method: 'POST', body: { source, apply: true } });
  ledger = imported.ledger;
  assert.equal(ledger.dataKind, 'personal');
  const importedAsset = gateAsset(ledger);
  assert.equal(importedAsset.id, 'row-900');
  balanceUnchanged({ ...importedAsset, id: asset.id }, asset);
  assert.equal(ledger.connections.gate.configured, true);
  assert.deepEqual(storedCredential(), beforeImportConnection);
  assert.equal(gateAsset(await success('/api/ledger')).value, 125.5);
  assert.ok(existsSync(join(dataDir, 'backups', imported.backupName)));
  assert.equal(gateCalls, expectedGateCalls, 'Import must preserve balances without querying Gate');
  assert.deepEqual(transportViolations, [], 'All outbound Gate requests must satisfy the signed GET contract');
  console.log('Gate production smoke passed: signed JSON GET, safe HTTP 400 response diagnostics, encrypted credentials, atomic connect/replace, independent refresh, retained failures/disconnect, manual aliases, duplicate rejection and import preservation');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  database?.close();
  if (module) {
    await new Promise(resolveClose => module.server.close(resolveClose));
    await module.close();
  }
  process.chdir(previousCwd);
}
