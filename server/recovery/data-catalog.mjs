// Declared material under DATA_DIR (evolution plan E6, docs/backup-recovery.md).
// inventory still walks the whole data root; a path declared here gets the
// listed category, every other path is `secrets` (it may hold cleartext
// credentials at any depth), including unknown SQLite files.
//
// The category of a path is part of backup manifest schema 1: restore requires
// entry.category to equal category(entry.path), so declaring, removing or
// re-categorising a `data` path makes older backups that contain it fail as
// RECOVERY_MANIFEST_INVALID. Such a change needs a new manifest schema that
// keeps the schema 1 categories for older backups
// (tests/recovery-data-catalog.test.mjs pins them).
//
// Fields:
//   path | pattern  exact relative path, or a RegExp over the whole path
//   owner          hub, shared, or the module id
//   category       data (application-encrypted databases and identity evidence) or secrets
//   required       every backup and restore refuses a checkpoint without it
//   key            the material that decrypts its credentials; credentials.mjs
//                  checks it against the stored ciphertext before a handoff
//                  retires the source and before a restore publishes
//   checkpoint     bounded by checkpoint evidence, which every handoff and every
//                  restore runs: `tables` are the journals whose rows and record
//                  sizes are bounded, `size` bounds the file itself. Absent
//                  material fails the evidence unless `optional`.
// Descriptive only (no code branches on them):
//   kind           sqlite, marker, key or config
//   references     environment keys that point at other included material; the
//                  Aster CA binding itself is handled by discoverPathBindings
// Module structure checks of a handoff stay in admission.mjs.
export const REGISTRY = 'execution-control.sqlite';
export const ASTER_ENV = 'modules/aster/.env';
export const ASTER_CA = 'ASTER_CAPACITY_RELAY_CA_FILE';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const DATA_CATALOG = Object.freeze([
  { path: REGISTRY, owner: 'shared', category: 'data', kind: 'sqlite', required: true, checkpoint: { tables: ['aw_operations', 'aw_isolations'] } },
  { path: REGISTRY + '.required', owner: 'shared', category: 'data', kind: 'marker', required: true },
  { path: 'hub.sqlite', owner: 'hub', category: 'data', kind: 'sqlite', required: true, key: 'credentials.key',
    checkpoint: { tables: ['execution_jobs', 'execution_orders', 'execution_locks', 'execution_stop_requests', 'projects', 'trading_accounts', 'execution_accounts'] } },
  { path: 'credentials.key', owner: 'hub', category: 'secrets', kind: 'key', required: true },
  { path: 'modules/monitor/market.sqlite', owner: 'monitor', category: 'data', kind: 'sqlite' },
  { path: 'modules/monitor/perpetual/market.sqlite', owner: 'monitor', category: 'data', kind: 'sqlite' },
  { path: 'modules/asset/ledger.sqlite', owner: 'asset', category: 'data', kind: 'sqlite', key: 'modules/asset/config.json', checkpoint: { tables: ['connections'], optional: true } },
  { pattern: new RegExp(`^modules/asset/backups/before-import-${UUID}\\.sqlite$`), owner: 'asset', category: 'data', kind: 'sqlite' },
  { path: 'modules/asset/config.json', owner: 'asset', category: 'secrets', kind: 'config' },
  { path: 'modules/crossex/crossex.sqlite', owner: 'crossex', category: 'data', kind: 'sqlite', key: 'modules/crossex/credentials.key',
    checkpoint: { tables: ['live_executions', 'live_orders', 'live_cache', 'live_connection', 'settings'] } },
  { path: 'modules/crossex/credentials.key', owner: 'crossex', category: 'secrets', kind: 'key' },
  { path: 'modules/greeks/.env', owner: 'greeks', category: 'secrets', kind: 'config', checkpoint: { size: true, optional: true } },
  { path: 'modules/greeks/engine_state.json', owner: 'greeks', category: 'secrets', kind: 'config', checkpoint: { size: true, optional: true } },
  { path: 'modules/aster/trading.sqlite3', owner: 'aster', category: 'data', kind: 'sqlite', checkpoint: { tables: ['accounts', 'deleted_accounts', 'pairs', 'intents', 'kv'] } },
  { path: ASTER_ENV, owner: 'aster', category: 'secrets', kind: 'config', references: [ASTER_CA] },
].map(entry => Object.freeze({ required: false, ...entry })));

const EXACT = new Map(DATA_CATALOG.filter(entry => entry.path).map(entry => [entry.path, entry]));
const PATTERNS = DATA_CATALOG.filter(entry => entry.pattern);
export const declared = relative => EXACT.get(relative) ?? PATTERNS.find(entry => entry.pattern.test(relative)) ?? null;
export const category = relative => declared(relative)?.category ?? 'secrets';
export const REQUIRED_MATERIAL = Object.freeze(DATA_CATALOG.filter(entry => entry.required).map(entry => entry.path));
export const CHECKPOINT_JOURNALS = Object.freeze(DATA_CATALOG.filter(entry => entry.checkpoint?.tables));
export const CHECKPOINT_SIZED = Object.freeze(DATA_CATALOG.filter(entry => entry.checkpoint?.size));
// The key that decrypts the credentials stored in a declared database or config.
export function credentialKey(relative) {
  const key = EXACT.get(relative)?.key;
  if (!key) throw new Error(`no credential key is declared for ${relative}`);
  return key;
}
