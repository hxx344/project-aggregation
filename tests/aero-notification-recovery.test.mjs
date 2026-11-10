import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Wallet } from 'ethers';
import { AUTO_DEFAULTS } from '../server/automation/aero-auto.mjs';
import { createAeroSafe } from '../server/automation/aero-safe.mjs';

const permissions = JSON.parse(readFileSync(new URL('../tools/aero-roles/config.example.json', import.meta.url), 'utf8'));
const KEY = `0x${'55'.repeat(32)}`, wallet = new Wallet(KEY).address;
const flush = async (count = 15) => { for (let i = 0; i < count; i++) await new Promise(setImmediate); };
async function settled(manager) { for (let i = 0; i < 100; i++) { if (!manager.state().refreshing) return; await delay(2); } throw new Error('fixture did not settle'); }
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aero-notification-recovery-')), store = join(directory, 'aero-safe'); mkdirSync(store);
  const config = { rpcUrl: 'https://rpc.invalid', safe: `0x${'11'.repeat(20)}`, roles: `0x${'22'.repeat(20)}`, permissions };
  writeFileSync(join(store, 'config.json'), JSON.stringify(config));
  writeFileSync(join(store, 'wallet.json'), JSON.stringify({ address: wallet, key: KEY }));
  writeFileSync(join(store, 'auto.json'), JSON.stringify({ schema: 1, config: { ...AUTO_DEFAULTS, enabled: false }, halted: { at: 1000, reason: 'prior interruption' }, history: [], reopen: null, closing: null }));
  const control = { now: 2000, mode: 'ok', reads: 0, posts: [], configured: true, gate: null };
  const chain = { connect: async () => ({ tokens: new Map() }), readState: async () => {
    const mode = control.mode, number = ++control.reads; if (mode === 'hold') await control.gate;
    if (mode === 'fail') throw new Error('RPC unavailable');
    return { blockNumber: number, timestamp: Math.floor(control.now / 1000), balances: {}, allowances: [], pools: [] };
  } };
  const managers = [];
  const make = async () => {
    const manager = createAeroSafe({ dataDir: directory, encrypt: x => x, decrypt: x => x, now: () => control.now, log: { warn() {} }, chain, makeProvider: () => ({}),
      notificationChannel: () => ({ alertChannel: () => ({ configured: control.configured, title: 'fixture' }), postAlert: async card => { control.posts.push(card); } }) });
    managers.push(manager); await manager.initialize(); return manager;
  };
  t.after(async () => { for (const manager of managers) await manager.close(); rmSync(directory, { recursive: true, force: true }); });
  const manager = await make(); await settled(manager); await manager.setNotifications({ interrupted: false, needs_review: false, recovered: true });
  return { manager, make, control, config };
}
const recoveries = manager => manager.state().notifications.history.filter(entry => entry.kind === 'recovered');

test('long halted automation does not recover from a day-old cache; only a successful post-enable read can notify', async t => {
  const f = await fixture(t), { manager, control } = f;
  control.now += 86_400_000; control.mode = 'fail';
  const enabled = await manager.setAuto({ enabled: true });
  assert.equal(enabled.notifications.history.some(entry => entry.kind === 'recovered'), false); assert.equal(control.reads, 1);
  await delay(15); await settled(manager); await flush();
  assert.match(manager.state().chainError, /RPC unavailable/); assert.equal(control.posts.length, 0); assert.deepEqual(recoveries(manager), []);
  control.mode = 'ok'; control.now++; await manager.tickAuto(); await flush();
  assert.equal(control.posts.length, 1); assert.equal(recoveries(manager)[0].status, 'confirmed');
  await manager.tickAuto(); await flush(); assert.equal(control.posts.length, 1, 'same recovery is not repeated');
});

test('a read begun before re-enable cannot become recovery evidence when its response arrives later', async t => {
  const { manager, control } = await fixture(t); control.now += 86_400_000;
  let release; control.gate = new Promise(resolve => { release = resolve; }); control.mode = 'hold';
  manager.refresh(); await flush(); assert.equal(control.reads, 2);
  await manager.setAuto({ enabled: true }); await delay(10); release(); await settled(manager); await flush();
  assert.equal(control.posts.length, 0); assert.deepEqual(recoveries(manager), []);
  control.mode = 'fail'; await manager.tickAuto(); await flush(); assert.equal(control.posts.length, 0);
  control.mode = 'ok'; await manager.tickAuto(); await flush(); assert.equal(control.posts.length, 1);
});

test('a timed-out response cannot restore notification evidence after the refresh already failed', async t => {
  const { manager, control } = await fixture(t); control.now += 86_400_000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release; control.gate = new Promise(resolve => { release = resolve; }); control.mode = 'hold';
  await manager.setAuto({ enabled: true }); t.mock.timers.tick(0); await flush(); assert.equal(control.reads, 2);
  t.mock.timers.tick(60_001); await flush(); assert.match(manager.state().chainError, /读取超过/);
  release(); await flush(); assert.equal(control.posts.length, 0); assert.deepEqual(recoveries(manager), []);
  control.mode = 'fail'; await manager.tickAuto(); await flush(); assert.equal(control.posts.length, 0);
  control.mode = 'ok'; await manager.tickAuto(); await flush(); assert.equal(control.posts.length, 1);
});

test('restart holds an unsent recovery until a new successful read, while config changes supersede its old evidence', async t => {
  const { manager, make, control, config } = await fixture(t); control.configured = false; control.now += 86_400_000;
  await manager.setAuto({ enabled: true }); await delay(10); await settled(manager); await flush();
  assert.equal(recoveries(manager)[0].status, 'pending'); await manager.close();
  control.mode = 'fail'; control.configured = true;
  const restarted = await make(); await settled(restarted); await restarted.tickAuto(); await flush();
  assert.equal(control.posts.length, 0); assert.equal(recoveries(restarted)[0].status, 'pending');
  control.mode = 'ok'; await restarted.tickAuto(); await flush(); assert.equal(control.posts.length, 1);
  // A separate pending recovery proves that configuration changes invalidate
  // a previous observation without manufacturing a channel acknowledgement.
  const next = await fixture(t); next.control.configured = false; next.control.now += 86_400_000;
  await next.manager.setAuto({ enabled: true }); await delay(10); await settled(next.manager); await flush();
  assert.equal(recoveries(next.manager)[0].status, 'pending');
  await next.manager.save({ ...config, slippageBps: 60 });
  assert.equal(recoveries(next.manager)[0].status, 'superseded');
  next.control.configured = true; await settled(next.manager); await next.manager.tickAuto(); await flush(); assert.equal(next.control.posts.length, 0);
});
