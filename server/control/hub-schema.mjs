import { createHash } from 'node:crypto';

// Version contract of hub.sqlite (docs/hub-schema-inventory.md). Version 1 is
// the layout the current creators produce on an empty database; each object is
// pinned by a digest of its stored definition, so a changed index condition or
// generated column is a different object even under the same name. A creator
// whose DDL changes fails tests/hub-schema.test.mjs until this contract gets a
// new version and a migration.
export const HUB_SCHEMA_VERSION = 1;

// name: [type, table, digest]
const V1 = Object.freeze({
  settings: ['table', 'settings', 'af92de5fb36c5153'],
  projects: ['table', 'projects', '5e28d74613b398b5'],
  snapshots: ['table', 'snapshots', '887117869aef009e'],
  sessions: ['table', 'sessions', '90db49395e0274d0'],
  idx_sessions_expires: ['index', 'sessions', 'f85025550b56f774'],
  execution_entries: ['table', 'execution_entries', '8ebc96601798ea36'],
  login_ip_attempts: ['table', 'login_ip_attempts', '470cb24ebd54d70f'],
  login_account_guard: ['table', 'login_account_guard', 'c71810ae0001c046'],
  login_pending: ['table', 'login_pending', '8fbe6ebec33d7ff1'],
  portal_tickets: ['table', 'portal_tickets', '1b143ff8d6218b5b'],
  idx_portal_tickets_expires: ['index', 'portal_tickets', 'f561b0ab0e37a974'],
  portal_grants: ['table', 'portal_grants', '7ce04326a3d86214'],
  idx_portal_grants_expires: ['index', 'portal_grants', 'ac819ebeb66c23c2'],
  trading_accounts: ['table', 'trading_accounts', '5823992dd98e24dd'],
  trading_views_v2: ['table', 'trading_views_v2', '2085540b5873433a'],
  trading_pnl_samples: ['table', 'trading_pnl_samples', 'b569919b1f3485cb'],
  trading_pnl_samples_v2: ['table', 'trading_pnl_samples_v2', '26eb2cfe814e48d2'],
  trading_pnl_migrations: ['table', 'trading_pnl_migrations', '8678f6d4e1e91dfb'],
  execution_accounts: ['table', 'execution_accounts', '53e9975831c2c9d2'],
  execution_jobs: ['table', 'execution_jobs', 'd77c256853c108e6'],
  execution_jobs_unfinished: ['index', 'execution_jobs', '1b8eaf36cf05841a'],
  execution_jobs_finished: ['index', 'execution_jobs', '623c82f0263e1502'],
  execution_orders: ['table', 'execution_orders', '261e237a4da752a8'],
  execution_orders_job: ['index', 'execution_orders', '1a7d5c416a418c4d'],
  execution_orders_unsettled: ['index', 'execution_orders', '2e275e6456014ebd'],
  execution_previews: ['table', 'execution_previews', '368e3751b1d41081'],
  idx_execution_previews_expires: ['index', 'execution_previews', 'cc9d5c7dc7d7cf48'],
  execution_requests: ['table', 'execution_requests', 'e4f6ae601c9db96d'],
  execution_locks: ['table', 'execution_locks', '83ebbd290d7fd33d'],
  execution_lease: ['table', 'execution_lease', '7be45568510fe87d'],
  execution_stop_requests: ['table', 'execution_stop_requests', '8ea54938a83de8eb'],
  execution_auto_rules: ['table', 'execution_auto_rules', '5be18e778282d22b'],
  execution_anthropic_reduction: ['table', 'execution_anthropic_reduction', '5310ce0635f5accb'],
  platform_baseline_samples: ['table', 'platform_baseline_samples', '3cf57c91af9d1db6'],
  platform_baseline_valid_bucket: ['index', 'platform_baseline_samples', '3db0bda4c71ee9df'],
});

// Version 0 forms the current creators still upgrade in place: the table
// before its added column. A missing object is the other known version 0 form.
const LEGACY = Object.freeze({
  trading_accounts: ['12feffbf72095265'], // without account_mode (d63940f)
  trading_pnl_samples_v2: ['3058de718fd00622'], // without cumulative_funding_pnl (e556f22)
  platform_baseline_samples: ['b527d5f3a5883111'], // without valid_sample
});

// Objects no code reads or writes any more; they may remain in any version.
const RETIRED = Object.freeze({
  trading_views: ['table', 'trading_views', 'd6374ac80fc3dcd2'], // replaced by trading_views_v2 (e556f22)
});

const digest = sql => createHash('sha256').update(String(sql).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

/**
 * Classifies the layout of hub.sqlite without writing: works on a query-only
 * connection. state is one of
 *   v1          user_version 1 and exactly the version 1 layout
 *   v0-complete user_version 0 and the version 1 layout: ready to be marked
 *   v0-legacy   user_version 0, only missing objects or known older forms,
 *               which the current creators complete
 *   newer       user_version above the version this code supports
 *   unknown     anything else; never migrate or mark it
 * Retired objects are reported but do not change the state.
 */
export function inspectHubSchema(db) {
  const userVersion = Number(Object.values(db.prepare('PRAGMA user_version').get())[0]);
  const present = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const legacy = [], mismatched = [], unexpected = [], retired = [];
  for (const { type, name, tbl_name: table, sql } of present) {
    const expected = Object.hasOwn(V1, name) ? V1[name] : null;
    const old = Object.hasOwn(RETIRED, name) ? RETIRED[name] : null;
    const same = spec => spec[0] === type && spec[1] === table;
    const value = sql == null ? null : digest(sql);
    if (expected) {
      if (!same(expected)) mismatched.push(name);
      else if (value === expected[2]) continue;
      else if (Object.hasOwn(LEGACY, name) && LEGACY[name].includes(value)) legacy.push(name);
      else mismatched.push(name);
    } else if (old && same(old) && value === old[2]) retired.push(name);
    else unexpected.push(name);
  }
  const names = new Set(present.map(row => row.name));
  const missing = Object.keys(V1).filter(name => !names.has(name)).sort();
  const result = state => ({ userVersion, state, missing, legacy, mismatched, unexpected, retired });
  if (!Number.isSafeInteger(userVersion) || userVersion < 0) return result('unknown');
  if (userVersion > HUB_SCHEMA_VERSION) return result('newer');
  if (mismatched.length || unexpected.length) return result('unknown');
  const complete = !missing.length && !legacy.length;
  if (userVersion === HUB_SCHEMA_VERSION) return result(complete ? 'v1' : 'unknown');
  return result(complete ? 'v0-complete' : 'v0-legacy');
}
