import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TTL_MS = 60_000;
export const RECOVERY_SCHEMA_VERSION = 1;
const HEARTBEAT_MS = 5_000;
const SAFETY_MS = 10_000;
/** Aster v3 nonce window (60 s around server time) plus 60 s clock tolerance. */
export const ASTER_WRITE_EXPIRY_MS = 120_000;
/**
 * Modules whose Aster margin transfers carry the margin-transfer intent: the legacy ASTER module (mainnet) and the
 * unified platform executor (`platform`, any one environment per transfer). Expiry only ever applies within one module.
 */
const MARGIN_MODULES = new Set(['aster', 'platform']);
const AUTHORITIES = new Set(['binance', 'bybit', 'okx', 'gate-crossex', 'aster', 'hyperliquid', 'rh-lighter']);
const ENVIRONMENTS = new Set(['mainnet', 'testnet', 'demo']);
const SECRET_KEY = /^(?:api[_-]?key|api[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|signer|signature|timestamp|nonce|passphrase|password|authorization|access[_-]?token|refresh[_-]?token|token)$/i;
const RECOVERY_IDS = ['authorityId', 'recoveryId', 'checkpointId', 'handoffId', 'sourceAuthorityId'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AccountWriterError extends Error {
  constructor(code) { super(`Account execution control: ${code}`); this.name = 'AccountWriterError'; this.code = code; }
}
const fail = (code) => { throw new AccountWriterError(code); };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const identifier = (value, code = 'INVALID_IDENTIFIER') => {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) fail(code);
  return value;
};
function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some((k) => !['authority', 'environment'].includes(k))) fail('INVALID_SCOPE');
  if (!AUTHORITIES.has(scope.authority) || !ENVIRONMENTS.has(scope.environment)) fail('INVALID_SCOPE');
  return { authority: scope.authority, environment: scope.environment };
}
function normalizeUid(value, authority) {
  // Wallet-addressed venues: the master account address, compared case-insensitively.
  if (authority === 'aster' || authority === 'hyperliquid' || authority === 'rh-lighter') {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail('INVALID_IDENTITY');
    return value.toLowerCase();
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_IDENTITY');
    value = String(value);
  }
  if (typeof value !== 'string' || !/^[0-9]{1,128}$/.test(value)) fail('INVALID_IDENTITY');
  const result = value.replace(/^0+/, '');
  if (!result) fail('INVALID_IDENTITY');
  return result;
}
export function normalizeAccountIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || Object.keys(identity).some((k) => !['authority', 'environment', 'accountId', 'parentAccountId'].includes(k))) fail('INVALID_IDENTITY');
  const scope = normalizeScope({ authority: identity.authority, environment: identity.environment });
  const result = { ...scope, accountId: normalizeUid(identity.accountId, scope.authority) };
  if (identity.parentAccountId != null) result.parentAccountId = normalizeUid(identity.parentAccountId, scope.authority);
  return result;
}
export function accountKey(identity) {
  const normalized = normalizeAccountIdentity(identity);
  return digest(`account-writer:v1\0${normalized.authority}\0${normalized.environment}\0${normalized.accountId}`);
}
function compareUnicode(a, b) {
  const aa = Array.from(a, (c) => c.codePointAt(0)); const bb = Array.from(b, (c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
}
// Numbers use their IEEE-754 bytes so Node and Python hash precisely the same semantics.
function semanticValue(value, depth = 0) {
  if (depth > 32) fail('INVALID_PAYLOAD');
  if (value === null) return ['null'];
  if (typeof value === 'string') {
    if (!value.isWellFormed()) fail('INVALID_PAYLOAD');
    return ['string', value];
  }
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail('INVALID_PAYLOAD');
    const number = Buffer.alloc(8); number.writeDoubleBE(Object.is(value, -0) ? 0 : value);
    return ['number', number.toString('hex')];
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail('INVALID_PAYLOAD');
    return ['array', value.map((v) => semanticValue(v, depth + 1))];
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_PAYLOAD');
  return ['object', Object.keys(value).sort(compareUnicode).map((key) => {
    if (!key.isWellFormed() || SECRET_KEY.test(key)) fail('UNSAFE_PAYLOAD');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) fail('INVALID_PAYLOAD');
    return [key, semanticValue(descriptor.value, depth + 1)];
  })];
}
function payloadHash(keys, payload) {
  const json = JSON.stringify(semanticValue({ accounts: keys, payload }));
  if (Buffer.byteLength(json) > 262_144) fail('INVALID_PAYLOAD');
  return digest(json);
}
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const positiveDecimal = (value) => typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) && value.length <= 128 && /[1-9]/.test(value);
function marginMetadata(moduleId, keys, payload) {
  const transfer = payload.marginTransfer;
  const invalid = () => fail('INVALID_MARGIN_TRANSFER');
  if (!MARGIN_MODULES.has(moduleId) || !exactKeys(payload, ['marginTransfer']) || !exactKeys(transfer, ['version', 'method', 'path', 'params', 'source', 'destination', 'master']) || transfer.version !== 1 || transfer.method !== 'POST' || transfer.path !== '/fapi/v3/subAccountTransfer') invalid();
  const params = transfer.params;
  if (!exactKeys(params, ['fromAccountAddress', 'toAccountAddress', 'asset', 'amount', 'kindType']) || params.asset !== 'USD1' || params.kindType !== 'FUTURE_FUTURE' || !positiveDecimal(params.amount) || !/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,8})?$/.test(params.amount)) invalid();
  const [whole, fraction = ''] = params.amount.split('.');
  if (BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0')) > 100_000_000_000_000_000n) invalid();
  const identities = ['source', 'destination', 'master'].map((role) => {
    const identity = transfer[role];
    // The legacy module only ever runs on mainnet; the platform keeps all three accounts in the one environment it runs in.
    const environment = moduleId === 'aster' ? 'mainnet' : transfer.source?.environment;
    if (!exactKeys(identity, ['authority', 'environment', 'accountId']) || identity.authority !== 'aster' || !ENVIRONMENTS.has(identity.environment) || identity.environment !== environment || typeof identity.accountId !== 'string' || !/^0x[0-9a-f]{40}$/.test(identity.accountId)) invalid();
    return identity;
  });
  const transferKeys = identities.map(accountKey).sort();
  if (new Set(transferKeys).size !== 3 || JSON.stringify(keys) !== JSON.stringify(transferKeys) || params.fromAccountAddress !== identities[0].accountId || params.toAccountAddress !== identities[1].accountId) invalid();
  return { action: 'margin-transfer', targetHash: payloadHash(keys, payload) };
}
function originalOrder(value) {
  const required = ['symbol', 'side', 'type', 'positionSide', 'quantity', 'newClientOrderId'];
  const allowed = [...required, 'newOrderRespType', 'timeInForce', 'price', 'reduceOnly'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.includes(key))) return false;
  return typeof value.symbol === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.symbol) && ['BUY', 'SELL'].includes(value.side) && ['LONG', 'SHORT', 'BOTH'].includes(value.positionSide) && ['MARKET', 'LIMIT'].includes(value.type) && positiveDecimal(value.quantity)
    && typeof value.newClientOrderId === 'string' && /^[A-Za-z0-9_.:/-]{1,36}$/.test(value.newClientOrderId)
    && (value.newOrderRespType === undefined || ['ACK', 'RESULT'].includes(value.newOrderRespType))
    && (value.timeInForce === undefined || ['GTC', 'IOC', 'FOK', 'GTX'].includes(value.timeInForce))
    && (value.price === undefined || positiveDecimal(value.price)) && (value.type !== 'LIMIT' || (value.price !== undefined && value.timeInForce !== undefined))
    && (value.reduceOnly === undefined || [true, false, 'true', 'false'].includes(value.reduceOnly));
}
const validSymbol = (value) => typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value);
const validLeverage = (value) => ['string', 'number'].includes(typeof value) && /^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-5])$/.test(String(value));
const legacyId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const matchingOrders = (orders, symbol = null) => Array.isArray(orders) && orders.length > 0 && orders.length <= 100 && orders.every((order) => originalOrder(order) && (symbol === null || order.symbol === symbol)) && new Set(orders.map((order) => order.newClientOrderId)).size === orders.length;
function nonfundingAction(payload) {
  if (exactKeys(payload, ['order']) && originalOrder(payload.order)) return 'order';
  if (exactKeys(payload, ['orders']) && Array.isArray(payload.orders) && payload.orders.length > 0 && payload.orders.length <= 100 && payload.orders.every(originalOrder)) return 'order';
  if (exactKeys(payload, ['symbol', 'target']) && validSymbol(payload.symbol) && validLeverage(payload.target)) return 'leverage';
  if (exactKeys(payload, ['id', 'kind', 'symbol', 'orders', 'target']) && legacyId(payload.id) && validSymbol(payload.symbol)) {
    if (['pair', 'cycle'].includes(payload.kind) && payload.target === null && matchingOrders(payload.orders, payload.symbol)) return 'order';
    if (payload.kind === 'migration' && payload.target === null && matchingOrders(payload.orders)) return 'order';
    if (['leverage', 'cycle_leverage'].includes(payload.kind) && payload.orders === null && validLeverage(payload.target)) return 'leverage';
  }
  if (exactKeys(payload, ['id', 'request_id', 'kind', 'symbol', 'target_leverage', 'amount', 'source', 'destination', 'orders']) && legacyId(payload.id) && (payload.request_id === null || legacyId(payload.request_id)) && validSymbol(payload.symbol) && payload.amount === null && payload.source === null && payload.destination === null) {
    if (['ordinary', 'cycle'].includes(payload.kind) && payload.target_leverage === null && matchingOrders(payload.orders, payload.symbol)) return 'order';
    if (payload.kind === 'leverage' && Array.isArray(payload.orders) && payload.orders.length === 0 && validLeverage(payload.target_leverage)) return 'leverage';
  }
  if (!exactKeys(payload, ['method', 'path', 'params'])) return null;
  const { method, path: endpoint, params } = payload;
  if (method === 'POST' && endpoint === '/fapi/v3/order' && originalOrder(params)) return 'order';
  if (method === 'POST' && endpoint === '/fapi/v3/batchOrders' && exactKeys(params, ['batchOrders'])) {
    let orders;
    try { orders = typeof params.batchOrders === 'string' ? JSON.parse(params.batchOrders) : params.batchOrders; } catch { return null; }
    if (Array.isArray(orders) && orders.length > 0 && orders.length <= 100 && orders.every(originalOrder)) return 'order';
  }
  if (method === 'POST' && endpoint === '/fapi/v3/leverage' && exactKeys(params, ['symbol', 'leverage']) && typeof params.symbol === 'string' && /^[A-Z0-9_]{1,64}$/.test(params.symbol) && /^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-5])$/.test(String(params.leverage)) && ['string', 'number'].includes(typeof params.leverage)) return 'leverage';
  return null;
}
function intentMetadata(moduleId, keys, payload) {
  if (payload && typeof payload === 'object' && Object.hasOwn(payload, 'marginTransfer')) return marginMetadata(moduleId, keys, payload);
  const action = payload?.intentAction; const target = payload?.intentTarget;
  if (action == null && target == null) {
    const inferred = nonfundingAction(payload);
    return { action: inferred, targetHash: inferred ? payloadHash(keys, payload) : null };
  }
  if (!['amend', 'cancel'].includes(action) || !target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some((key) => !['accountKey', 'symbol', 'clientOrderId', 'remoteId'].includes(key)) || (!target.clientOrderId && !target.remoteId)) fail('INVALID_INTENT_TARGET');
  const targetKey = Object.hasOwn(target, 'accountKey') ? target.accountKey : (keys.length === 1 ? keys[0] : null);
  if (!targetKey || !keys.includes(targetKey)) fail('INVALID_INTENT_TARGET');
  identifier(target.symbol, 'INVALID_INTENT_TARGET');
  for (const key of ['clientOrderId', 'remoteId']) if (target[key] !== undefined) identifier(target[key], 'INVALID_INTENT_TARGET');
  const semanticTarget = { ...target }; delete semanticTarget.accountKey;
  // ASTER compatibility cannot be granted by self-described intent plus arbitrary payload.
  if (moduleId === 'aster' && (Object.keys(payload).some((key) => !['intentAction', 'intentTarget', 'price', 'quantity', 'groupId'].includes(key)) || ['price', 'quantity'].some((key) => Object.hasOwn(payload, key) && !positiveDecimal(payload[key])))) fail('INVALID_INTENT_TARGET');
  return { action, targetHash: payloadHash([targetKey], semanticTarget) };
}
// An expired unknown Aster write next to a margin transfer no longer gates the other.
// Aster signs each write with a nonce valid only 60 s around server time. An
// unknown row was last updated after its send attempt ended, so past that
// window plus clock tolerance the original cannot execute. A new margin
// transfer ignores any such write; any new write ignores such a transfer.
function expiredAsterWrite(operation, pending, time) {
  return operation.module_id === pending.module_id && MARGIN_MODULES.has(pending.module_id) && pending.state === 'unknown'
    && (operation.intent_action === 'margin-transfer' || pending.intent_action === 'margin-transfer')
    && time - Math.max(pending.created_at, pending.updated_at) >= ASTER_WRITE_EXPIRY_MS;
}
function reducesAmendRisk(operation, pending) {
  return operation.intent_action === 'cancel' && operation.intent_target_hash && pending.module_id === operation.module_id && pending.intent_action === 'amend' && pending.intent_target_hash === operation.intent_target_hash;
}
function safeDatabasePath(databasePath) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath) || /^(?:\\\\|\/\/|\\\?\?\\)/.test(databasePath) || databasePath.includes('\0')) fail('UNSAFE_DATABASE_PATH');
  if (process.platform === 'win32' && databasePath.slice(2).includes(':')) fail('UNSAFE_DATABASE_PATH');
  const resolved = path.resolve(databasePath);
  let markerPresent = false;
  try { fs.lstatSync(`${resolved}.required`); markerPresent = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (markerPresent && !fs.existsSync(resolved)) fail('REGISTRY_MISSING');
  const parent = path.dirname(resolved);
  const checkComponents = (target) => {
    let current = path.parse(target).root;
    for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('UNSAFE_DATABASE_PATH');
    }
  };
  checkComponents(resolved);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  checkComponents(resolved);
  if (/^(?:\\\\|\/\/)/.test(fs.realpathSync.native(parent))) fail('UNSAFE_DATABASE_PATH');
  if (process.platform !== 'win32') {
    let ancestor = parent;
    while (true) {
      const info = fs.statSync(ancestor);
      const trustedOwner = info.uid === 0 || info.uid === process.getuid();
      const foreignCanRename = (info.mode & 0o003) === 0o003 || (info.mode & 0o030) === 0o030;
      if (!trustedOwner || (foreignCanRename && !(info.mode & 0o1000))) fail('UNSAFE_DATABASE_PATH');
      const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next;
    }
    const directory = fs.statSync(parent);
    if ((directory.mode & 0o022) || directory.uid !== process.getuid()) fail('UNSAFE_DATABASE_PATH');
  }
  if (!fs.existsSync(resolved)) {
    try { fs.closeSync(fs.openSync(resolved, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0), 0o600)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== 'win32' && stat.uid !== process.getuid())) fail('UNSAFE_DATABASE_PATH');
  fs.chmodSync(resolved, 0o600);
  try {
    if (fs.existsSync(`${resolved}.required`) || fs.lstatSync(`${resolved}.required`).isSymbolicLink()) {
      const { evidence } = readRequired(`${resolved}.required`); const current = fileIdentity(resolved);
      if (evidence.schema !== 1 || evidence.dev !== current.dev || evidence.ino !== current.ino || typeof evidence.registryId !== 'string') fail('REGISTRY_REPLACED');
    }
  } catch (error) { if (error.code !== 'ENOENT') { if (error instanceof AccountWriterError) throw error; fail('REGISTRY_REPLACED'); } }
  for (const suffix of ['-wal', '-shm']) {
    let sidecar;
    try { sidecar = fs.lstatSync(resolved + suffix); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1 || (process.platform !== 'win32' && sidecar.uid !== process.getuid())) fail('UNSAFE_DATABASE_PATH');
    fs.chmodSync(resolved + suffix, 0o600);
  }
  return resolved;
}
function fileIdentity(target) {
  const info = fs.lstatSync(target, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) fail('REGISTRY_REPLACED');
  return { dev: String(info.dev), ino: String(info.ino) };
}
function readRequired(target) {
  const deadline = performance.now() + 750;
  while (true) {
    const info = fs.lstatSync(target, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) fail('REGISTRY_REPLACED');
    let evidence;
    try { evidence = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { fail('REGISTRY_REPLACED'); }
    if (!evidence || Object.keys(evidence).length !== 4 || evidence.schema !== 1 || typeof evidence.registryId !== 'string' || !/^[0-9a-f-]{36}$/.test(evidence.registryId)) fail('REGISTRY_REPLACED');
    if (info.nlink === 2n) {
      const prefix = `${path.basename(target)}.tmp-`;
      const candidates = fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith(prefix)).filter((name) => {
        const match = /^([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(name.slice(prefix.length));
        if (!match || defaultAlive(Number(match[1]))) return false;
        try {
          const entry = fs.lstatSync(path.join(path.dirname(target), name), { bigint: true });
          return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 2n && entry.dev === info.dev && entry.ino === info.ino && (process.platform === 'win32' || entry.uid === BigInt(process.getuid()));
        } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      });
      if (candidates.length === 1) {
        const databasePath = target.slice(0, -'.required'.length); const databaseIdentity = fileIdentity(databasePath);
        if (!target.endsWith('.required') || evidence.dev !== databaseIdentity.dev || evidence.ino !== databaseIdentity.ino) fail('REGISTRY_REPLACED');
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try { database.exec('PRAGMA busy_timeout=750'); if (database.prepare("SELECT value FROM aw_meta WHERE key='registry_id'").get()?.value !== evidence.registryId) fail('REGISTRY_REPLACED'); }
        finally { database.close(); }
        let candidate;
        try { candidate = fs.lstatSync(path.join(path.dirname(target), candidates[0]), { bigint: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const required = fs.lstatSync(target, { bigint: true });
        if (required.nlink === 1n) continue;
        if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.dev !== info.dev || candidate.ino !== info.ino || candidate.nlink !== 2n || required.dev !== info.dev || required.ino !== info.ino || required.nlink !== 2n) fail('REGISTRY_REPLACED');
        try { fs.unlinkSync(path.join(path.dirname(target), candidates[0])); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (process.platform !== 'win32') {
          const directory = fs.openSync(path.dirname(target), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
          try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
        continue;
      }
      if (performance.now() >= deadline) fail('REGISTRY_BUSY');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue;
    }
    if (info.nlink !== 1n) fail('REGISTRY_REPLACED');
    return { identity: { dev: String(info.dev), ino: String(info.ino) }, evidence };
  }
}
function registryMarkerAdmission(database, databasePath) {
  const required = `${databasePath}.required`; const deadline = performance.now() + 750;
  const markerPresent = () => { try { fs.lstatSync(required); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; } };
  const rejectMissing = () => { if (markerPresent()) return false; fail('REGISTRY_MISSING'); };
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  while (true) {
    if (markerPresent()) return false;
    const meta = tables.includes('aw_meta') ? database.prepare("SELECT key,value FROM aw_meta WHERE key IN ('registry_id','recovery_schema','recovery_state')").all() : [];
    if (meta.some((row) => row.key !== 'registry_id')) {
      // A concurrent cold publisher can finish between the path and meta reads.
      return rejectMissing();
    }
    const registryId = meta.find((row) => row.key === 'registry_id')?.value;
    if (registryId === undefined) {
      const known = ['aw_meta', 'aw_owners', 'aw_bindings', 'aw_accounts', 'aw_operations', 'aw_operation_accounts', 'aw_isolations'];
      if (tables.some((name) => !known.includes(name)) || tables.some((name) => name === 'aw_meta' ? database.prepare("SELECT 1 FROM aw_meta WHERE key<>'schema' LIMIT 1").get() : database.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get())) return rejectMissing();
      return true;
    }
    if (typeof registryId !== 'string' || !UUID.test(registryId)) fail('REGISTRY_REPLACED');
    const expected = { schema: 1, registryId, ...fileIdentity(databasePath) }; const prefix = `${path.basename(required)}.tmp-`;
    for (const name of fs.readdirSync(path.dirname(required)).filter((entry) => entry.startsWith(prefix))) {
      const match = /^([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(name.slice(prefix.length));
      if (!match || !defaultAlive(Number(match[1]))) continue;
      const target = path.join(path.dirname(required), name);
      try {
        const info = fs.lstatSync(target);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 || (process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077))) continue;
        const evidence = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (evidence && Object.keys(evidence).length === 4 && Object.keys(expected).every((key) => evidence[key] === expected[key])) return true;
      } catch (error) { if (error instanceof AccountWriterError) throw error; }
    }
    if (performance.now() >= deadline) return rejectMissing();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS aw_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO aw_meta VALUES ('schema','1');
CREATE TABLE IF NOT EXISTS aw_owners (owner_id TEXT PRIMARY KEY, module_id TEXT NOT NULL, runtime_id TEXT NOT NULL, pid INTEGER NOT NULL, status TEXT NOT NULL, last_now INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS aw_bindings (module_id TEXT NOT NULL, connection_id TEXT NOT NULL, authority TEXT NOT NULL, environment TEXT NOT NULL, account_key TEXT, revision TEXT NOT NULL, generation INTEGER NOT NULL, active INTEGER NOT NULL, evidence_hash TEXT, PRIMARY KEY(module_id,connection_id));
CREATE TABLE IF NOT EXISTS aw_accounts (account_key TEXT PRIMARY KEY, authority TEXT NOT NULL, environment TEXT NOT NULL, module_id TEXT NOT NULL, owner_id TEXT NOT NULL, fence INTEGER NOT NULL, lease_until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS aw_operations (operation_id TEXT PRIMARY KEY, module_id TEXT NOT NULL, body_hash TEXT NOT NULL, account_keys TEXT NOT NULL, owner_id TEXT NOT NULL, ticket_json TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, group_id TEXT NOT NULL, intent_action TEXT, intent_target_hash TEXT);
CREATE TABLE IF NOT EXISTS aw_operation_accounts (operation_id TEXT NOT NULL, account_key TEXT NOT NULL, PRIMARY KEY(operation_id,account_key));
CREATE INDEX IF NOT EXISTS aw_operation_account_lookup ON aw_operation_accounts(account_key,operation_id);
CREATE TABLE IF NOT EXISTS aw_isolations (account_key TEXT PRIMARY KEY, authority TEXT NOT NULL, environment TEXT NOT NULL, reason TEXT NOT NULL, module_id TEXT NOT NULL, created_at INTEGER NOT NULL);
`;
const defaultAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

export function createAccountWriter(options) { return new AccountWriter(options); }

const DIAGNOSTIC_MODULES = ['hub', 'aster', 'greeks', 'crossex'];
const DIAGNOSTIC_ROW_LIMIT = 200;
const diagnosticRef = (writer, kind, value) => `${kind}-${digest(`${writer.registryId}\0${kind}\0${value}`).slice(0, 20)}`;
const diagnosticModule = (value) => DIAGNOSTIC_MODULES.includes(value) ? value : 'other';
const diagnosticTime = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Unlike the admission check, a diagnostic read never recovers marker links or
// retires a writer. A marker being published is unknown until a later GET.
function checkDiagnosticRegistry(writer) {
  try {
    const current = fileIdentity(writer.databasePath);
    const marker = fs.lstatSync(writer.requiredPath, { bigint: true });
    if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 1024n) fail('REGISTRY_REPLACED');
    if (marker.nlink === 2n) fail('REGISTRY_BUSY');
    if (marker.nlink !== 1n) fail('REGISTRY_REPLACED');
    const evidence = JSON.parse(fs.readFileSync(writer.requiredPath, 'utf8'));
    if (!evidence || Object.keys(evidence).length !== 4 || evidence.schema !== 1 || evidence.registryId !== writer.registryId || evidence.dev !== current.dev || evidence.ino !== current.ino || current.dev !== writer.registryIdentity.dev || current.ino !== writer.registryIdentity.ino || String(marker.dev) !== writer.markerIdentity.dev || String(marker.ino) !== writer.markerIdentity.ino) fail('REGISTRY_REPLACED');
  } catch (error) {
    if (error.code === 'ENOENT') fail('REGISTRY_MISSING');
    if (error instanceof AccountWriterError) throw error;
    fail('REGISTRY_UNAVAILABLE');
  }
}

function diagnosticProjection(writer, recovery, current, rowLimit) {
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > DIAGNOSTIC_ROW_LIMIT) throw new RangeError('Invalid diagnostic row limit');
  if (diagnosticTime(current) === null || (writer.lastNow !== undefined && current < writer.lastNow)) fail('INVALID_CLOCK');
  // One statement observes rows, pending counts and module evidence together.
  // Only the indexed pending junction is joined; no private ticket is selected.
  const result = writer.db.prepare(`WITH
    pending AS (
      SELECT oa.account_key, SUM(o.state='sending') AS sending, SUM(o.state='unknown') AS unknown,
        MIN(o.created_at) AS oldest_at, MAX(o.updated_at) AS latest_at
      FROM aw_operation_accounts oa JOIN aw_operations o USING(operation_id)
      WHERE o.state IN ('sending','unknown') GROUP BY oa.account_key
    ), candidates AS (
      SELECT account_key,module_id FROM aw_accounts
      UNION SELECT account_key,module_id FROM aw_bindings WHERE active=1 AND account_key IS NOT NULL
      UNION SELECT account_key,module_id FROM aw_isolations
      UNION SELECT oa.account_key,o.module_id FROM aw_operation_accounts oa JOIN aw_operations o USING(operation_id) WHERE o.state IN ('sending','unknown')
    ), limited AS (
      SELECT *,COUNT(*) OVER() AS total_rows FROM candidates ORDER BY account_key,module_id LIMIT ?
    )
    SELECT c.*, COALESCE(a.authority,i.authority,(SELECT b.authority FROM aw_bindings b WHERE b.account_key=c.account_key AND b.active=1 LIMIT 1)) AS authority,
      COALESCE(a.environment,i.environment,(SELECT b.environment FROM aw_bindings b WHERE b.account_key=c.account_key AND b.active=1 LIMIT 1)) AS environment,
      a.owner_id,a.module_id AS lease_module,a.lease_until,ow.status AS owner_status,ow.last_now AS owner_seen_at,
      p.sending,p.unknown,p.oldest_at,p.latest_at,i.reason AS isolation_reason,i.created_at AS isolation_at,
      (SELECT json_group_array(module_id) FROM (
        SELECT DISTINCT CASE WHEN b.module_id IN ('hub','aster','greeks','crossex') THEN b.module_id ELSE 'other' END AS module_id
        FROM aw_bindings b WHERE b.active=1 AND b.account_key IS NULL AND b.module_id<>c.module_id
          AND b.authority=COALESCE(a.authority,i.authority,(SELECT z.authority FROM aw_bindings z WHERE z.account_key=c.account_key AND z.active=1 LIMIT 1))
          AND b.environment=COALESCE(a.environment,i.environment,(SELECT z.environment FROM aw_bindings z WHERE z.account_key=c.account_key AND z.active=1 LIMIT 1))
        ORDER BY module_id)) AS unverified_modules,
      (SELECT value FROM aw_meta WHERE key='recovery_state') AS recovery_state,
      (SELECT json_group_array(json_object('moduleId',module_id,'active',active,'closed',closed,'lastSeenAt',last_seen)) FROM
        (SELECT CASE WHEN module_id IN ('hub','aster','greeks','crossex') THEN module_id ELSE 'other' END AS module_id,
          SUM(status='active') AS active,SUM(status='closed') AS closed,MAX(last_now) AS last_seen FROM aw_owners GROUP BY 1)) AS module_owners,
      (SELECT json_group_array(json_object('moduleId',module_id,'count',count)) FROM
        (SELECT CASE WHEN module_id IN ('hub','aster','greeks','crossex') THEN module_id ELSE 'other' END AS module_id,COUNT(*) AS count FROM aw_bindings WHERE active=1 AND account_key IS NULL GROUP BY 1)) AS unverified_bindings
    FROM (SELECT 1) seed LEFT JOIN limited c ON 1=1
    LEFT JOIN aw_accounts a ON a.account_key=c.account_key
    LEFT JOIN aw_owners ow ON ow.owner_id=a.owner_id
    LEFT JOIN pending p ON p.account_key=c.account_key
    LEFT JOIN aw_isolations i ON i.account_key=c.account_key`).all(rowLimit);
  const observedRecovery = JSON.parse(result[0].recovery_state);
  if (!observedRecovery || observedRecovery.schemaVersion !== recovery.schemaVersion || observedRecovery.state !== recovery.state || RECOVERY_IDS.some((key) => observedRecovery[key] !== recovery[key])) fail('REGISTRY_BUSY');
  const rows = result.filter((row) => row.account_key !== null).map((row) => {
    const ownerState = row.owner_id === null ? 'missing' : row.owner_status === 'active' ? 'active' : row.owner_status === 'closed' ? 'closed' : row.owner_status === null ? 'missing' : 'unknown';
    const leaseUntil = diagnosticTime(row.lease_until);
    const leaseState = row.owner_id === null ? 'missing' : leaseUntil === null ? 'unknown' : leaseUntil <= current ? 'expired' : 'active';
    const reasons = [];
    const unverifiedModules = JSON.parse(row.unverified_modules);
    if (recovery.state !== 'normal') reasons.push(recovery.state === 'quarantine' ? 'recovery-quarantine' : 'authority-retired');
    if (writer.retired) reasons.push('writer-retired');
    if (row.isolation_reason !== null) reasons.push('account-isolated');
    if (unverifiedModules.length) reasons.push('unverified-binding');
    if (ownerState !== 'active') reasons.push(`owner-${ownerState}`);
    if (leaseState !== 'active') reasons.push(`lease-${leaseState}`);
    if (row.lease_module !== null && row.lease_module !== row.module_id) reasons.push('lease-conflict');
    if (row.sending > 0) reasons.push('sending');
    if (row.unknown > 0) reasons.push('unknown-result');
    return {
      accountRef: diagnosticRef(writer, 'account', row.account_key), moduleId: diagnosticModule(row.module_id), moduleRef: diagnosticRef(writer, 'module', row.module_id),
      authority: AUTHORITIES.has(row.authority) ? row.authority : 'unknown', environment: ENVIRONMENTS.has(row.environment) ? row.environment : 'unknown',
      lease: { state: leaseState, until: leaseUntil, moduleId: row.lease_module === null ? null : diagnosticModule(row.lease_module) },
      owner: { ref: row.owner_id === null ? null : diagnosticRef(writer, 'owner', row.owner_id), state: ownerState, lastSeenAt: diagnosticTime(row.owner_seen_at) },
      pending: { sending: row.sending ?? 0, unknown: row.unknown ?? 0, oldestAt: diagnosticTime(row.oldest_at), latestAt: diagnosticTime(row.latest_at) },
      isolation: row.isolation_reason === null ? null : { reason: ['legacy-conflict', 'identity-conflict', 'manual-isolation'].includes(row.isolation_reason) ? row.isolation_reason : 'unknown', since: diagnosticTime(row.isolation_at) },
      unverifiedModules, reasons,
    };
  });
  const owners = JSON.parse(result[0].module_owners);
  const unverified = JSON.parse(result[0].unverified_bindings);
  const modules = [...new Set([...DIAGNOSTIC_MODULES, ...owners.map((row) => diagnosticModule(row.moduleId)), ...unverified.map((row) => diagnosticModule(row.moduleId))])].map((moduleId) => {
    const observed = owners.filter((row) => diagnosticModule(row.moduleId) === moduleId);
    const unverifiedRows = unverified.filter((row) => diagnosticModule(row.moduleId) === moduleId);
    return { moduleId, ownerEvidence: observed.length ? 'observed' : 'unknown', reachability: 'unknown',
      activeOwners: observed.length ? observed.reduce((sum, row) => sum + row.active, 0) : null, closedOwners: observed.length ? observed.reduce((sum, row) => sum + row.closed, 0) : null,
      lastSeenAt: observed.reduce((latest, row) => Math.max(latest ?? 0, diagnosticTime(row.lastSeenAt) ?? 0), null),
      unverifiedBindings: observed.length || unverifiedRows.length ? unverifiedRows.reduce((sum, row) => sum + row.count, 0) : null };
  });
  const totalRows = result[0].total_rows ?? 0;
  return { schemaVersion: 1, generatedAt: current, registry: 'available', completeness: totalRows > rowLimit ? 'truncated' : 'complete', scope: 'observed-registry',
    rowLimit, totalRows, truncated: totalRows > rowLimit, recovery: { state: recovery.state, since: null }, modules, rows };
}

// The public GET remains useful when protection is disabled or its registry
// cannot be read. Error text, paths and private identifiers never cross it.
export function getAccountWriterDiagnostics(writer, { rowLimit = DIAGNOSTIC_ROW_LIMIT, now = Date.now } = {}) {
  const empty = { schemaVersion: 1, enabled: Boolean(writer), accounts: [], bindings: [], operations: [], isolations: [] };
  try {
    if (writer) return { schemaVersion: 1, enabled: true, ...writer.snapshot({ includeDiagnostics: true, rowLimit }) };
  } catch (error) {
    const code = ['REGISTRY_MISSING', 'REGISTRY_REPLACED', 'REGISTRY_BUSY', 'WRITER_CLOSED', 'INVALID_CLOCK', 'INVALID_RECOVERY_STATE', 'UNSUPPORTED_RECOVERY_SCHEMA'].includes(error.code) ? error.code : 'REGISTRY_UNAVAILABLE';
    return { ...empty, diagnostics: unavailableDiagnostics('unavailable', code, now(), rowLimit) };
  }
  return { ...empty, diagnostics: unavailableDiagnostics('disabled', 'PROTECTION_DISABLED', now(), rowLimit) };
}
function unavailableDiagnostics(registry, errorCode, generatedAt, rowLimit) {
  return { schemaVersion: 1, generatedAt: diagnosticTime(generatedAt), registry, errorCode, completeness: 'unknown', scope: 'observed-registry', rowLimit, totalRows: null, truncated: false,
    recovery: { state: 'unknown', since: null }, modules: DIAGNOSTIC_MODULES.map((moduleId) => ({ moduleId, ownerEvidence: 'unknown', reachability: 'unknown', activeOwners: null, closedOwners: null, lastSeenAt: null, unverifiedBindings: null })), rows: [] };
}

export class AccountWriter {
  get recoveryProtectionVersion() { return RECOVERY_SCHEMA_VERSION; }
  // heartbeatMs only shortens the renewal beat (tests); it can never exceed the production 5s beat.
  constructor({ databasePath, moduleId, runtimeId, ownerId = randomUUID(), pid = process.pid, now = Date.now, processAlive = defaultAlive, heartbeatMs = HEARTBEAT_MS }) {
    this.moduleId = identifier(moduleId); this.runtimeId = identifier(runtimeId); this.ownerId = identifier(ownerId);
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof now !== 'function' || typeof processAlive !== 'function' || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > HEARTBEAT_MS) fail('INVALID_OPTIONS');
    this.pid = pid; this.now = now; this.processAlive = processAlive; this.heartbeatMs = heartbeatMs; this.retired = false; this.closed = false; this.timer = null; this.held = new Map();
    try {
      this.databasePath = safeDatabasePath(databasePath);
      if (fs.statSync(this.databasePath).size > 0) {
        const admission = new DatabaseSync(this.databasePath, { readOnly: true });
        try { admission.exec('PRAGMA busy_timeout=750'); registryMarkerAdmission(admission, this.databasePath); }
        finally { admission.close(); }
      }
      this.db = new DatabaseSync(this.databasePath);
      this.db.exec('PRAGMA busy_timeout=750');
      registryMarkerAdmission(this.db, this.databasePath);
      this.db.exec('PRAGMA busy_timeout=750; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.db.exec(SCHEMA);
      if (this.db.prepare("SELECT value FROM aw_meta WHERE key='schema'").get()?.value !== '1') fail('UNSUPPORTED_SCHEMA');
      this._registerFile();
      const time = this._time();
      this._transaction(() => this.db.prepare('INSERT INTO aw_owners VALUES (?,?,?,?,?,?)').run(this.ownerId, this.moduleId, this.runtimeId, this.pid, 'active', time), { initializeRecovery: true });
    } catch (error) {
      this.db?.close();
      if (error instanceof AccountWriterError) throw error;
      if (/UNIQUE constraint/.test(error.message)) fail('OWNER_ID_REUSED');
      this._error(error);
    }
  }
  _error(error) {
    if (error instanceof AccountWriterError) throw error;
    fail(/busy|locked/i.test(error?.message ?? '') ? 'REGISTRY_BUSY' : 'REGISTRY_UNAVAILABLE');
  }
  _transaction(action, { initializeRecovery = false, closing = false } = {}) {
    let started = false;
    try {
      if (this.registryIdentity) this._checkRegistryFile();
      this.db.exec('BEGIN IMMEDIATE'); started = true;
      if (initializeRecovery) {
        if (!this.db.prepare("SELECT 1 FROM aw_meta WHERE key='recovery_state'").get() && this.db.prepare("SELECT 1 FROM aw_meta WHERE key='recovery_schema'").get()) fail('INVALID_RECOVERY_STATE');
        this.db.prepare("INSERT OR IGNORE INTO aw_meta VALUES ('recovery_state',?)").run(JSON.stringify({ schemaVersion: 1, authorityId: randomUUID(), state: 'normal' }));
        this.db.prepare("INSERT OR IGNORE INTO aw_meta VALUES ('recovery_schema','1')").run();
      }
      if (!closing) this._recoveryGate(0);
      const result = action();
      if (this.registryIdentity) this._checkRegistryFile();
      this.db.exec('COMMIT'); return result;
    }
    catch (error) { if (started) try { this.db.exec('ROLLBACK'); } catch {} this._error(error); }
  }
  _recoveryState() {
    const schema = this.db.prepare("SELECT value FROM aw_meta WHERE key='recovery_schema'").get()?.value;
    if (schema !== undefined && schema !== '1') fail('UNSUPPORTED_RECOVERY_SCHEMA');
    const raw = this.db.prepare("SELECT value FROM aw_meta WHERE key='recovery_state'").get()?.value;
    let value;
    try { if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65_536) fail('INVALID_RECOVERY_STATE'); value = JSON.parse(raw); }
    catch (error) { if (error instanceof AccountWriterError) throw error; fail('INVALID_RECOVERY_STATE'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.schemaVersion)) fail('INVALID_RECOVERY_STATE');
    if (value.schemaVersion !== 1) fail('UNSUPPORTED_RECOVERY_SCHEMA');
    if (Object.keys(value).some((key) => !['schemaVersion', 'state', 'admittedTarget', ...RECOVERY_IDS].includes(key)) || !['normal', 'quarantine', 'retired'].includes(value.state) || !UUID.test(value.authorityId ?? '')) fail('INVALID_RECOVERY_STATE');
    for (const key of RECOVERY_IDS) if (Object.hasOwn(value, key) && (typeof value[key] !== 'string' || !UUID.test(value[key]))) fail('INVALID_RECOVERY_STATE');
    if (Object.hasOwn(value, 'admittedTarget') && (!value.admittedTarget || typeof value.admittedTarget !== 'object' || Array.isArray(value.admittedTarget))) fail('INVALID_RECOVERY_STATE');
    return value;
  }
  _recoveryGate(budgetMs) {
    const value = this._recoveryState();
    if (value.state === 'retired') fail('AUTHORITY_RETIRED');
    if (value.state === 'quarantine' && budgetMs > 0) fail('RECOVERY_REQUIRED');
    return value;
  }
  _registerFile() {
    const mayPublish = registryMarkerAdmission(this.db, this.databasePath);
    this.registryIdentity = fileIdentity(this.databasePath);
    if (mayPublish) this.db.prepare("INSERT OR IGNORE INTO aw_meta VALUES ('registry_id',?)").run(randomUUID());
    this.registryId = this.db.prepare("SELECT value FROM aw_meta WHERE key='registry_id'").get()?.value;
    if (typeof this.registryId !== 'string' || !UUID.test(this.registryId)) fail('REGISTRY_REPLACED');
    this.requiredPath = `${this.databasePath}.required`;
    if (mayPublish) {
      const content = JSON.stringify({ schema: 1, registryId: this.registryId, ...this.registryIdentity });
      const temporary = `${this.requiredPath}.tmp-${process.pid}-${randomUUID()}`;
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor);
        fs.closeSync(descriptor); descriptor = undefined;
        try { fs.linkSync(temporary, this.requiredPath); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        fs.unlinkSync(temporary);
        if (process.platform !== 'win32') {
          const directory = fs.openSync(path.dirname(this.requiredPath), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
          try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        }
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    this.markerIdentity = readRequired(this.requiredPath).identity;
    if (process.platform !== 'win32' && fs.statSync(this.requiredPath).uid !== process.getuid()) fail('UNSAFE_DATABASE_PATH');
    fs.chmodSync(this.requiredPath, 0o600);
    this._checkRegistryFile();
  }
  _checkRegistryFile() {
    try {
      const current = fileIdentity(this.databasePath); const { identity: marker, evidence } = readRequired(this.requiredPath);
      if (current.dev !== this.registryIdentity.dev || current.ino !== this.registryIdentity.ino || marker.dev !== this.markerIdentity.dev || marker.ino !== this.markerIdentity.ino || evidence.schema !== 1 || evidence.registryId !== this.registryId || evidence.dev !== current.dev || evidence.ino !== current.ino) fail('REGISTRY_REPLACED');
    } catch (error) {
      this.retired = true;
      if (error.code === 'ENOENT') fail('REGISTRY_MISSING');
      if (error instanceof AccountWriterError) throw error;
      fail('REGISTRY_REPLACED');
    }
  }
  _time() {
    if (this.closed) fail('WRITER_CLOSED');
    if (this.retired) fail('WRITER_RETIRED');
    const time = this.now();
    if (!Number.isSafeInteger(time) || time < 0) { this.retired = true; fail('INVALID_CLOCK'); }
    if (this.lastNow !== undefined && time < this.lastNow) { this.retired = true; fail('CLOCK_ROLLBACK'); }
    this.lastNow = time; return time;
  }
  _owner(time) {
    const owner = this.db.prepare('SELECT * FROM aw_owners WHERE owner_id=?').get(this.ownerId);
    if (!owner || owner.status !== 'active' || owner.module_id !== this.moduleId || owner.runtime_id !== this.runtimeId || owner.pid !== this.pid) { this.retired = true; fail('OWNERSHIP_LOST'); }
    if (time < owner.last_now) { this.retired = true; fail('CLOCK_ROLLBACK'); }
    this.db.prepare('UPDATE aw_owners SET last_now=? WHERE owner_id=?').run(time, this.ownerId);
  }
  bind(connectionId, identity, revision, scope = undefined) {
    identifier(connectionId);
    if (!['string', 'number'].includes(typeof revision) || (typeof revision === 'number' && !Number.isSafeInteger(revision))) fail('INVALID_REVISION');
    const revisionValue = JSON.stringify(revision);
    if (revisionValue.length > 512) fail('INVALID_REVISION');
    const normalized = identity == null ? null : normalizeAccountIdentity(identity);
    const normalizedScope = normalized ? { authority: normalized.authority, environment: normalized.environment } : normalizeScope(scope);
    if (scope && JSON.stringify(normalizeScope(scope)) !== JSON.stringify(normalizedScope)) fail('INVALID_SCOPE');
    const key = normalized ? accountKey(normalized) : null;
    const evidenceHash = normalized ? digest(JSON.stringify(normalized)) : null;
    const time = this._time();
    return this._transaction(() => {
      this._owner(time);
      const old = this.db.prepare('SELECT * FROM aw_bindings WHERE module_id=? AND connection_id=?').get(this.moduleId, connectionId);
      const changed = !old || !old.active || old.authority !== normalizedScope.authority || old.environment !== normalizedScope.environment || old.account_key !== key || old.revision !== revisionValue || old.evidence_hash !== evidenceHash;
      const generation = old ? old.generation + Number(changed) : 1;
      this.db.prepare('INSERT INTO aw_bindings VALUES (?,?,?,?,?,?,?,1,?) ON CONFLICT(module_id,connection_id) DO UPDATE SET authority=excluded.authority,environment=excluded.environment,account_key=excluded.account_key,revision=excluded.revision,generation=excluded.generation,active=1,evidence_hash=excluded.evidence_hash').run(this.moduleId, connectionId, normalizedScope.authority, normalizedScope.environment, key, revisionValue, generation, evidenceHash);
      if (changed && old?.account_key) this.held.delete(old.account_key);
      return { connectionId, generation, accountKey: key, verified: key !== null };
    });
  }
  claim(identities) {
    if (!Array.isArray(identities) || !identities.length || identities.length > 100) fail('INVALID_ACCOUNT_SET');
    const normalized = identities.map(normalizeAccountIdentity);
    const accounts = new Map(normalized.map((identity) => [accountKey(identity), identity]));
    if (accounts.size !== normalized.length) fail('DUPLICATE_ACCOUNT');
    const time = this._time();
    const ticket = this._transaction(() => {
      this._owner(time);
      const claims = []; const bindings = [];
      for (const key of [...accounts.keys()].sort()) {
        const identity = accounts.get(key);
        if (this.db.prepare('SELECT 1 FROM aw_isolations WHERE account_key=?').get(key)) fail('ACCOUNT_ISOLATED');
        if (this.db.prepare('SELECT 1 FROM aw_bindings WHERE active=1 AND module_id<>? AND authority=? AND environment=? AND account_key IS NULL LIMIT 1').get(this.moduleId, identity.authority, identity.environment)) fail('UNVERIFIED_BINDING');
        const verified = this.db.prepare('SELECT connection_id,generation FROM aw_bindings WHERE active=1 AND module_id=? AND account_key=? ORDER BY connection_id').all(this.moduleId, key);
        if (!verified.length) fail('BINDING_REQUIRED');
        bindings.push(...verified.map((row) => ({ connectionId: row.connection_id, generation: row.generation, accountKey: key })));
        const old = this.db.prepare('SELECT * FROM aw_accounts WHERE account_key=?').get(key);
        if (old && old.module_id !== this.moduleId) fail('ACCOUNT_PINNED');
        let fence = old?.fence ?? 1;
        if (old?.owner_id === this.ownerId) {
          if (old.lease_until <= time) { this.retired = true; fail('LEASE_EXPIRED'); }
        } else if (old) {
          const owner = this.db.prepare('SELECT * FROM aw_owners WHERE owner_id=?').get(old.owner_id);
          if (!owner || (owner.status !== 'closed' && this.processAlive(owner.pid))) fail('OWNER_ALIVE');
          fence += 1;
        }
        this.db.prepare('INSERT INTO aw_accounts VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_key) DO UPDATE SET owner_id=excluded.owner_id,fence=excluded.fence,lease_until=excluded.lease_until').run(key, identity.authority, identity.environment, this.moduleId, this.ownerId, fence, time + TTL_MS);
        claims.push({ accountKey: key, fence });
      }
      return { ownerId: this.ownerId, moduleId: this.moduleId, runtimeId: this.runtimeId, claims, bindings };
    });
    for (const claim of ticket.claims) this.held.set(claim.accountKey, { claim, bindings: ticket.bindings.filter((b) => b.accountKey === claim.accountKey) });
    this._heartbeatStart();
    return ticket;
  }
  _validate(ticket, time, budgetMs, renewAlways = false) {
    if (!ticket || ticket.ownerId !== this.ownerId || ticket.moduleId !== this.moduleId || ticket.runtimeId !== this.runtimeId || !Array.isArray(ticket.claims) || !ticket.claims.length || !Array.isArray(ticket.bindings)) fail('INVALID_TICKET');
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 0 || budgetMs > TTL_MS - SAFETY_MS) fail('INVALID_BUDGET');
    this._recoveryGate(budgetMs);
    this._owner(time);
    const keys = new Set();
    for (const claim of ticket.claims) {
      if (!claim || typeof claim.accountKey !== 'string' || !/^[a-f0-9]{64}$/.test(claim.accountKey) || !Number.isSafeInteger(claim.fence) || claim.fence < 1 || keys.has(claim.accountKey)) fail('INVALID_TICKET');
      keys.add(claim.accountKey);
      if (this.db.prepare('SELECT 1 FROM aw_isolations WHERE account_key=?').get(claim.accountKey)) fail('ACCOUNT_ISOLATED');
      const row = this.db.prepare('SELECT * FROM aw_accounts WHERE account_key=?').get(claim.accountKey);
      if (!row || row.owner_id !== this.ownerId || row.module_id !== this.moduleId || row.fence !== claim.fence) { this.retired = true; fail('OWNERSHIP_LOST'); }
      if (row.lease_until <= time) { this.retired = true; fail('LEASE_EXPIRED'); }
      const relevant = ticket.bindings.filter((b) => b.accountKey === claim.accountKey);
      const current = this.db.prepare('SELECT connection_id,generation FROM aw_bindings WHERE active=1 AND module_id=? AND account_key=? ORDER BY connection_id').all(this.moduleId, claim.accountKey);
      if (!relevant.length || current.length !== relevant.length || current.some((b) => !relevant.some((old) => old.connectionId === b.connection_id && old.generation === b.generation))) fail('BINDING_CHANGED');
      if (this.db.prepare('SELECT 1 FROM aw_bindings WHERE active=1 AND module_id<>? AND authority=? AND environment=? AND account_key IS NULL LIMIT 1').get(this.moduleId, row.authority, row.environment)) fail('UNVERIFIED_BINDING');
      if (renewAlways || row.lease_until - time < budgetMs + SAFETY_MS) this.db.prepare('UPDATE aw_accounts SET lease_until=? WHERE account_key=? AND owner_id=? AND fence=?').run(time + TTL_MS, claim.accountKey, this.ownerId, claim.fence);
    }
    if (ticket.bindings.some((binding) => !keys.has(binding.accountKey))) fail('INVALID_TICKET');
    return true;
  }
  _validateSending(ticket, time) {
    identifier(ticket.operationId, 'INVALID_OPERATION_ID');
    const operation = this.db.prepare('SELECT * FROM aw_operations WHERE operation_id=?').get(ticket.operationId);
    if (!operation) fail('OPERATION_NOT_FOUND');
    const base = { ownerId: ticket.ownerId, moduleId: ticket.moduleId, runtimeId: ticket.runtimeId, claims: ticket.claims, bindings: ticket.bindings };
    if (operation.owner_id !== this.ownerId || operation.module_id !== this.moduleId || operation.body_hash !== ticket.bodyHash || JSON.stringify(JSON.parse(operation.ticket_json)) !== JSON.stringify(base)) fail('OPERATION_CONFLICT');
    if (operation.state !== 'sending') fail(operation.state === 'confirmed' ? 'ALREADY_SUBMITTED' : operation.state === 'rejected' ? 'ALREADY_REJECTED' : 'OPERATION_UNRESOLVED');
    for (const claim of ticket.claims) {
      const pending = this.db.prepare("SELECT o.* FROM aw_operation_accounts a JOIN aw_operations o ON o.operation_id=a.operation_id WHERE a.account_key=? AND o.operation_id<>? AND o.state IN ('sending','unknown')").all(claim.accountKey, ticket.operationId);
      if (pending.some((row) => row.state === 'unknown' ? !reducesAmendRisk(operation, row) && !this._marginCompatible(operation, row) && !expiredAsterWrite(operation, row, time) : operation.intent_action === 'margin-transfer' && !this._marginCompatible(operation, row))) fail('ACCOUNT_UNRESOLVED');
    }
  }
  _marginCompatible(operation, pending) {
    if (operation.module_id !== 'aster' || operation.intent_action !== 'margin-transfer' || !operation.intent_target_hash || pending.module_id !== 'aster') return false;
    if (!['order', 'leverage', 'amend', 'cancel'].includes(pending.intent_action) || !pending.intent_target_hash) return false;
    if (pending.state === 'unknown') return true;
    if (pending.state !== 'sending') return false;
    // A fenced ticket may have passed its final guard already. Its sender must also be dead.
    let ticket; let keys;
    try { ticket = JSON.parse(pending.ticket_json); keys = JSON.parse(pending.account_keys); } catch { return false; }
    if (ticket?.ownerId !== pending.owner_id || ticket.moduleId !== pending.module_id || !Array.isArray(ticket.claims) || !ticket.claims.length || !Array.isArray(keys) || keys.length !== ticket.claims.length || new Set(keys).size !== keys.length || !Array.isArray(ticket.bindings) || !ticket.bindings.length) return false;
    if (new Set(ticket.claims.map((claim) => claim?.accountKey)).size !== keys.length || ticket.bindings.some((binding) => !exactKeys(binding, ['connectionId', 'generation', 'accountKey']) || typeof binding.connectionId !== 'string' || !binding.connectionId.length || binding.connectionId.length > 256 || /[\x00-\x1f\x7f]/.test(binding.connectionId) || !keys.includes(binding.accountKey) || !Number.isSafeInteger(binding.generation) || binding.generation < 1) || new Set(ticket.bindings.map((binding) => binding.connectionId)).size !== ticket.bindings.length) return false;
    let fenced = true;
    for (const claim of ticket.claims) {
      if (!claim || !keys.includes(claim.accountKey) || !Number.isSafeInteger(claim.fence) || claim.fence < 1) return false;
      const current = this.db.prepare('SELECT owner_id,fence,module_id FROM aw_accounts WHERE account_key=?').get(claim.accountKey);
      if (!current || current.module_id !== 'aster' || !ticket.bindings.some((binding) => binding.accountKey === claim.accountKey)) return false;
      fenced &&= current.owner_id !== pending.owner_id || current.fence !== claim.fence;
    }
    if (!fenced) return false;
    const owner = this.db.prepare('SELECT * FROM aw_owners WHERE owner_id=?').get(pending.owner_id);
    if (!owner || owner.module_id !== 'aster' || owner.runtime_id !== ticket.runtimeId || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !['active', 'closed'].includes(owner.status)) return false;
    try { return this.processAlive(owner.pid) === false; } catch { return false; }
  }
  assertOwned(ticket, budgetMs = 35_000) {
    const time = this._time();
    return this._transaction(() => { this._validate(ticket, time, budgetMs); if (budgetMs > 0 && Object.hasOwn(ticket, 'operationId')) this._validateSending(ticket, time); return true; });
  }
  _heartbeatStart() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.held.size) return;
      try {
        const time = this._time();
        this._transaction(() => {
          for (const [key, value] of this.held) {
            const ticket = { ownerId: this.ownerId, moduleId: this.moduleId, runtimeId: this.runtimeId, claims: [value.claim], bindings: value.bindings };
            try { this._validate(ticket, time, 0, true); }
            catch (error) { if (['ACCOUNT_ISOLATED', 'BINDING_CHANGED', 'UNVERIFIED_BINDING'].includes(error.code)) this.held.delete(key); else throw error; }
          }
        });
      } catch (error) {
        // A briefly locked registry is retried next beat; an expired lease still retires via _validate.
        if (error?.code === 'REGISTRY_BUSY' && !this.retired) return;
        this.retired = true; clearInterval(this.timer); this.timer = null;
      }
    }, this.heartbeatMs);
    this.timer.unref();
  }
  _operationTicket(ticket, operationId, bodyHash, state) { return { ...JSON.parse(JSON.stringify(ticket)), operationId, bodyHash, state }; }
  _record(ticket, operationId, payload, importing) {
    identifier(operationId, 'INVALID_OPERATION_ID');
    const keys = ticket?.claims?.map((claim) => claim.accountKey).sort();
    if (!keys?.length) fail('INVALID_TICKET');
    const hash = payloadHash(keys, payload); const time = this._time();
    const groupId = payload && typeof payload === 'object' && !Array.isArray(payload) && payload.groupId != null ? identifier(payload.groupId, 'INVALID_GROUP_ID') : operationId;
    const intent = intentMetadata(this.moduleId, keys, payload);
    return this._transaction(() => {
      this._validate(ticket, time, importing ? 0 : 35_000);
      const old = this.db.prepare('SELECT * FROM aw_operations WHERE operation_id=?').get(operationId);
      if (old) {
        if (old.module_id !== this.moduleId || old.body_hash !== hash || old.account_keys !== JSON.stringify(keys)) fail('OPERATION_CONFLICT');
        if (importing) {
          if (old.intent_action === null && old.intent_target_hash === null) {
            if (intent.action !== null) this.db.prepare('UPDATE aw_operations SET intent_action=?,intent_target_hash=? WHERE operation_id=?').run(intent.action, intent.targetHash, operationId);
          } else if (old.intent_action !== intent.action || old.intent_target_hash !== intent.targetHash) fail('OPERATION_CONFLICT');
          return this._operationTicket(ticket, operationId, hash, old.state);
        }
        fail(old.state === 'confirmed' ? 'ALREADY_SUBMITTED' : old.state === 'rejected' ? 'ALREADY_REJECTED' : 'OPERATION_UNRESOLVED');
      }
      if (!importing) for (const key of keys) {
        const pending = this.db.prepare("SELECT o.* FROM aw_operation_accounts a JOIN aw_operations o ON o.operation_id=a.operation_id WHERE a.account_key=? AND o.state IN ('sending','unknown')").all(key);
        const proposed = { module_id: this.moduleId, intent_action: intent.action, intent_target_hash: intent.targetHash };
        if (pending.some((row) => !reducesAmendRisk(proposed, row) && !this._marginCompatible(proposed, row) && !expiredAsterWrite(proposed, row, time) && (intent.action === 'margin-transfer' || row.state !== 'sending' || row.module_id !== this.moduleId || row.owner_id !== this.ownerId || row.group_id !== groupId || row.account_keys !== JSON.stringify(keys) || JSON.stringify(JSON.parse(row.ticket_json)) !== JSON.stringify(ticket)))) fail('ACCOUNT_UNRESOLVED');
      }
      const state = importing ? 'unknown' : 'sending';
      this.db.prepare('INSERT INTO aw_operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(operationId, this.moduleId, hash, JSON.stringify(keys), this.ownerId, JSON.stringify(ticket), state, time, time, groupId, intent.action, intent.targetHash);
      for (const key of keys) this.db.prepare('INSERT INTO aw_operation_accounts VALUES (?,?)').run(operationId, key);
      return this._operationTicket(ticket, operationId, hash, state);
    });
  }
  prepare(ticket, operationId, payload) { return this._record(ticket, operationId, payload, false); }
  importUnknown(ticket, operationId, payload) { return this._record(ticket, operationId, payload, true); }
  finish(operationTicket, outcome) {
    if (!['confirmed', 'rejected', 'unknown'].includes(outcome)) fail('INVALID_OUTCOME');
    const time = this._time();
    return this._transaction(() => {
      this._validate(operationTicket, time, 0);
      const operation = this.db.prepare('SELECT * FROM aw_operations WHERE operation_id=?').get(operationTicket.operationId);
      if (!operation) fail('OPERATION_NOT_FOUND');
      if (operation.owner_id !== this.ownerId || operation.module_id !== this.moduleId || operation.body_hash !== operationTicket.bodyHash || JSON.stringify(JSON.parse(operation.ticket_json)) !== JSON.stringify({ ownerId: operationTicket.ownerId, moduleId: operationTicket.moduleId, runtimeId: operationTicket.runtimeId, claims: operationTicket.claims, bindings: operationTicket.bindings })) fail('OPERATION_CONFLICT');
      if (['confirmed', 'rejected'].includes(operation.state) && operation.state !== outcome) fail('OPERATION_FINAL');
      this.db.prepare('UPDATE aw_operations SET state=?,updated_at=? WHERE operation_id=?').run(outcome, time, operationTicket.operationId);
      return { operationId: operationTicket.operationId, state: outcome };
    });
  }
  resolve(operationId, ticket, outcome = 'confirmed') {
    identifier(operationId, 'INVALID_OPERATION_ID');
    if (!['confirmed', 'rejected'].includes(outcome)) fail('INVALID_OUTCOME');
    const time = this._time();
    return this._transaction(() => {
      this._validate(ticket, time, 0);
      const operation = this.db.prepare('SELECT * FROM aw_operations WHERE operation_id=?').get(operationId);
      if (!operation) fail('OPERATION_NOT_FOUND');
      const keys = ticket.claims.map((c) => c.accountKey).sort();
      if (operation.module_id !== this.moduleId || !JSON.parse(operation.account_keys).every((key) => keys.includes(key))) fail('OPERATION_CONFLICT');
      if (['confirmed', 'rejected'].includes(operation.state) && operation.state !== outcome) fail('OPERATION_FINAL');
      this.db.prepare('UPDATE aw_operations SET state=?,updated_at=? WHERE operation_id=?').run(outcome, time, operationId);
      return { operationId, state: outcome };
    });
  }
  unresolved(ticket) {
    const time = this._time();
    return this._transaction(() => {
      this._validate(ticket, time, 0);
      const keys = new Set(ticket.claims.map((claim) => claim.accountKey));
      return this.db.prepare("SELECT operation_id,body_hash,account_keys,state,created_at,updated_at FROM aw_operations WHERE module_id=? AND state IN ('sending','unknown') ORDER BY created_at,operation_id").all(this.moduleId).filter((row) => JSON.parse(row.account_keys).every((key) => keys.has(key))).map((row) => ({ operationId: row.operation_id, bodyHash: row.body_hash, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }));
    });
  }
  freeze(identities, reason = 'legacy-conflict') {
    if (!Array.isArray(identities) || !identities.length || identities.length > 100 || !['legacy-conflict', 'identity-conflict', 'manual-isolation'].includes(reason)) fail('INVALID_ISOLATION');
    const normalized = identities.map(normalizeAccountIdentity); const time = this._time();
    return this._transaction(() => {
      this._owner(time);
      for (const identity of normalized) {
        const key = accountKey(identity);
        if (!this.db.prepare('SELECT 1 FROM aw_bindings WHERE active=1 AND module_id=? AND account_key=?').get(this.moduleId, key)) fail('BINDING_REQUIRED');
        this.db.prepare('INSERT OR IGNORE INTO aw_isolations VALUES (?,?,?,?,?,?)').run(key, identity.authority, identity.environment, reason, this.moduleId, time);
      }
      return { isolated: normalized.length, reason };
    });
  }
  releaseBinding(connectionId) {
    identifier(connectionId); const time = this._time();
    return this._transaction(() => {
      this._owner(time);
      const binding = this.db.prepare('SELECT * FROM aw_bindings WHERE module_id=? AND connection_id=?').get(this.moduleId, connectionId);
      if (!binding?.active) return false;
      const pending = this.db.prepare("SELECT ticket_json FROM aw_operations WHERE module_id=? AND state IN ('sending','unknown')").all(this.moduleId);
      if (pending.some((row) => JSON.parse(row.ticket_json).bindings.some((b) => b.connectionId === connectionId))) fail('BINDING_UNRESOLVED');
      this.db.prepare('UPDATE aw_bindings SET active=0,generation=generation+1 WHERE module_id=? AND connection_id=?').run(this.moduleId, connectionId);
      if (binding.account_key) this.held.delete(binding.account_key);
      return true;
    });
  }
  /** Strictly read-only job export. Local order ids must come from the caller's persisted job,
   * never a browser-supplied list. No registry repair, lease, owner or settlement mutation. */
  executionEvidence(jobId, localIds) {
    if (this.closed) fail('WRITER_CLOSED');
    const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    if (!uuid(jobId) || !Array.isArray(localIds) || localIds.length > 4000 || localIds.some(id => !uuid(id))) throw new TypeError('Invalid execution evidence identity');
    checkDiagnosticRegistry(this);
    const prefix = `hub:${jobId}:`, candidateLimit = 4001, rows = [];
    // Drive the primary-key index from each original order. Bound raw candidates before
    // module/group filtering, so foreign/malformed suffixes cannot create an unbounded scan.
    const fields = 'operation_id,module_id,state,created_at,updated_at,group_id,intent_action';
    const exact = this.db.prepare(`SELECT ${fields} FROM aw_operations WHERE operation_id IN (?,?,?) ORDER BY operation_id LIMIT ?`);
    const range = this.db.prepare(`SELECT ${fields} FROM aw_operations WHERE operation_id>=? AND operation_id<? ORDER BY operation_id LIMIT ?`);
    let scannedCandidates = 0, ordersVisited = 0;
    const collect = (candidates, validId) => {
      for (const row of candidates) {
        scannedCandidates++;
        if (row.module_id === 'hub' && (row.group_id === null || row.group_id.startsWith(prefix)) && validId(row.operation_id)) rows.push(row);
      }
    };
    for (const localId of new Set(localIds)) {
      if (scannedCandidates >= candidateLimit) break;
      ordersVisited++;
      const ids = [`hub:create:${localId}`, `hub:legacy-amend:${localId}`, `hub:legacy-cancel:${localId}`];
      collect(exact.all(...ids, candidateLimit - scannedCandidates), id => ids.includes(id));
      for (const action of ['amend', 'cancel']) {
        if (scannedCandidates >= candidateLimit) break;
        const operationPrefix = `hub:${action}:${localId}:`;
        collect(range.all(operationPrefix, operationPrefix + '\uffff', candidateLimit - scannedCandidates),
          id => id.startsWith(operationPrefix) && /^\d{1,16}$/.test(id.slice(operationPrefix.length)));
      }
    }
    // Only bounded candidates are sorted; no full-registry ORDER BY or correlated join.
    rows.sort((left, right) => left.created_at - right.created_at || left.operation_id.localeCompare(right.operation_id));
    checkDiagnosticRegistry(this);
    return { available: true, truncated: scannedCandidates >= candidateLimit || rows.length > 4000,
      candidateLimit, scannedCandidates, ordersVisited, attempts: rows.slice(0, 4000).map(row => ({
      operationId: row.operation_id, state: row.state, createdAt: diagnosticTime(row.created_at), updatedAt: diagnosticTime(row.updated_at),
      groupId: row.group_id, action: row.intent_action,
    })) };
  }
  snapshot({ includeDiagnostics = false, rowLimit = DIAGNOSTIC_ROW_LIMIT } = {}) {
    if (this.closed) fail('WRITER_CLOSED');
    try {
      if (includeDiagnostics) checkDiagnosticRegistry(this); else this._checkRegistryFile();
      const recoveryState = this._recoveryState();
      const recovery = { schemaVersion: recoveryState.schemaVersion, state: recoveryState.state };
      for (const key of RECOVERY_IDS) if (Object.hasOwn(recoveryState, key)) recovery[key] = recoveryState[key];
      const accounts = this.db.prepare('SELECT authority,environment,module_id,lease_until,owner_id FROM aw_accounts ORDER BY authority,environment,module_id').all();
      const current = this.now();
      const isolations = this.db.prepare('SELECT authority,environment,reason,module_id FROM aw_isolations ORDER BY authority,environment,module_id').all().map((row) => ({ authority: row.authority, environment: row.environment, reason: row.reason, moduleId: row.module_id }));
      const snapshot = { accounts: accounts.map((row) => ({ authority: row.authority, environment: row.environment, moduleId: row.module_id, state: this.db.prepare('SELECT status FROM aw_owners WHERE owner_id=?').get(row.owner_id)?.status === 'closed' ? 'closed' : row.lease_until <= current ? 'expired' : 'owned' })), bindings: this.db.prepare('SELECT authority,environment,module_id,CASE WHEN account_key IS NULL THEN 0 ELSE 1 END AS verified,COUNT(*) AS count FROM aw_bindings WHERE active=1 GROUP BY authority,environment,module_id,verified').all().map((row) => ({ authority: row.authority, environment: row.environment, moduleId: row.module_id, verified: Boolean(row.verified), count: row.count })), operations: this.db.prepare('SELECT module_id,state,COUNT(*) AS count FROM aw_operations GROUP BY module_id,state').all().map((row) => ({ moduleId: row.module_id, state: row.state, count: row.count })), isolations, recovery, writerRetired: this.retired };
      if (includeDiagnostics) { snapshot.diagnostics = diagnosticProjection(this, recovery, current, rowLimit); checkDiagnosticRegistry(this); }
      return snapshot;
    } catch (error) { this._error(error); }
  }
  // Startup recovery maps these ids back to the private records that still
  // hold their evidence, instead of rereading every finished record.
  pendingOperationIds() {
    if (this.closed) fail('WRITER_CLOSED');
    try {
      this._checkRegistryFile();
      return this.db.prepare("SELECT operation_id FROM aw_operations WHERE module_id=? AND state IN ('sending','unknown') ORDER BY created_at,operation_id").all(this.moduleId).map((row) => row.operation_id);
    } catch (error) { this._error(error); }
  }
  close() {
    // The adapter must stop new requests and drain all in-flight transport before close.
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    try { this._transaction(() => this.db.prepare("UPDATE aw_owners SET status='closed' WHERE owner_id=?").run(this.ownerId), { closing: true }); }
    finally { this.closed = true; this.db.close(); }
  }
}
