import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_SAMPLES_PER_POOL, SAMPLE_RETENTION_SEC, openMarketSamples, pickSlots } from '../server/research/aero-market-samples.mjs';

const HOUR = 3600, T0 = 1_800_000_000 - (1_800_000_000 % HOUR);
const silent = { warn() {} };
const row = (address, extra = {}) => ({
  address, gauge: '0xgauge', tick: 100, stakedLiquidity: '1000000000000000000', fee: 500, emissionPerSec: 0.1,
  token0: { usd: 3000 }, token1: { usd: 1 }, vol24h: { daily: 0.02 }, vol7d: { daily: 0.018 }, ...extra,
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aero-samples-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { t: T0 + 600 };
  const open = () => openMarketSamples({ file: join(dir, 'samples.sqlite'), log: silent, now: () => clock.t * 1000 });
  return { dir, clock, open };
}

test('one sample per pool and hour; a later reading only fills a missing emission or AERO price', (t) => {
  const { clock, open } = fixture(t);
  const samples = open(); t.after(() => samples.close());
  // 重启后首轮：排放速率还没有、Base 还没给出 AERO 价。
  samples.record('ink', clock.t, [row('0xp', { emissionPerSec: null, tick: 90 })], null);
  samples.record('ink', clock.t + 60, [row('0xp', { tick: 95 }), row('0xnogauge', { gauge: null }), row('0xidle', { emissionPerSec: 0 })], 0.5);
  samples.record('ink', clock.t + 120, [row('0xp', { tick: 120, emissionPerSec: 9 })], 0.5);
  const read = samples.read('24h');
  assert.equal(read.available, true);
  assert.deepEqual(Object.keys(read.pools), ['ink:0xp'], 'no gauge or no emission in the window means no average');
  const [[slot, tick, staked, usd0, usd1, emissionUsd, v24, v7, fee]] = read.pools['ink:0xp'].samples;
  assert.deepEqual([slot, tick, staked, usd0, usd1, emissionUsd, v24, v7, fee], [T0, 95, 1e18, 3000, 1, 0.05, 0.02, 0.018, 500],
    'the null-emission reading was completed once, then the hour stayed fixed');
  assert.equal(read.pools['ink:0xp'].hours, 1);
});

test('slot picking keeps short lists whole and spreads long ones evenly with both ends', () => {
  for (const n of [0, 1, 24, 25, 720]) {
    const slots = Array.from({ length: n }, (_, i) => (n - i) * HOUR);
    const picked = pickSlots(slots);
    assert.equal(picked.length, Math.min(n, MAX_SAMPLES_PER_POOL));
    assert.equal(new Set(picked).size, picked.length);
    assert.ok(picked.every((v, i) => i === 0 || v < picked[i - 1]));
    if (n) { assert.equal(picked[0], slots[0]); assert.equal(picked.at(-1), slots.at(-1)); }
  }
});

test('long windows thin out to a fixed number of evenly spaced samples from the oldest to the newest hour', (t) => {
  const { clock, open } = fixture(t);
  const samples = open(); t.after(() => samples.close());
  const start = clock.t;
  for (let h = 0; h < 30 * 24; h++) samples.record('base', start + h * HOUR, [row('0xp', { tick: h })], 0.5);
  clock.t = start + (30 * 24 - 1) * HOUR;
  const month = samples.read('30d'), day = samples.read('24h');
  assert.equal(month.pools['base:0xp'].hours, 720);
  const ticks = month.pools['base:0xp'].samples.map((s) => s[1]);
  assert.equal(ticks.length, MAX_SAMPLES_PER_POOL);
  assert.equal(ticks[0], 0); assert.equal(ticks.at(-1), 719);
  assert.ok(ticks.every((v, i) => i === 0 || [31, 32].includes(v - ticks[i - 1])), `even spacing, got ${ticks}`);
  assert.deepEqual(day.pools['base:0xp'].samples.map((s) => s[1]), Array.from({ length: 24 }, (_, i) => 696 + i));
  // 读缓存遇到新样本即失效。
  clock.t += HOUR;
  samples.record('base', clock.t, [row('0xp', { tick: 9999 })], 0.5);
  assert.equal(samples.read('24h').pools['base:0xp'].samples.at(-1)[1], 9999);
});

test('each pool is sampled over its own hours: gaps, young pools and chains scanning on different hours', (t) => {
  const { clock, open } = fixture(t);
  const samples = open(); t.after(() => samples.close());
  const start = clock.t;
  // 两条链各每 2 小时扫一次、奇偶错开；另有一个最近 20 小时才出现的池子、一个中间断了 300 小时的池子。
  for (let h = 0; h < 720; h++) {
    const at = start + h * HOUR;
    if (h % 2 === 0) samples.record('base', at, [row('0xeven', { tick: h }), ...(h < 200 || h >= 500 ? [row('0xgap', { tick: h })] : [])], 0.5);
    else samples.record('ink', at, [row('0xodd', { tick: h }), ...(h >= 700 ? [row('0xyoung', { tick: h })] : [])], 0.5);
  }
  clock.t = start + 719 * HOUR;
  const { pools } = samples.read('30d');
  assert.deepEqual(Object.keys(pools), ['base:0xeven', 'base:0xgap', 'ink:0xodd', 'ink:0xyoung'], 'sorted keys, no chain dropped');
  assert.equal(pools['base:0xeven'].samples.length, MAX_SAMPLES_PER_POOL);
  assert.equal(pools['ink:0xodd'].samples.length, MAX_SAMPLES_PER_POOL);
  assert.equal(pools['ink:0xodd'].samples.at(-1)[1], 719);
  assert.deepEqual(pools['ink:0xyoung'].samples.map((s) => s[1]), Array.from({ length: 10 }, (_, i) => 701 + 2 * i));
  assert.equal(pools['ink:0xyoung'].hours, 10);
  const gap = pools['base:0xgap'];
  assert.equal(gap.hours, 210); assert.equal(gap.samples.length, MAX_SAMPLES_PER_POOL);
  assert.equal(gap.samples[0][1], 0); assert.equal(gap.samples.at(-1)[1], 718);
  // 按该池实际 210 个整点均匀取：断档前 100 个、后 110 个，点数也大致按此分开。
  const before = gap.samples.filter((s) => s[1] < 200).length;
  assert.ok(before >= 10 && gap.samples.length - before >= 10, `split across the gap, got ${before} before`);
});

test('samples older than the retention are pruned and the rest survive a reopen', (t) => {
  const { clock, open } = fixture(t);
  let samples = open();
  samples.record('base', clock.t, [row('0xold')], 0.5);
  clock.t += SAMPLE_RETENTION_SEC + 2 * HOUR;
  samples.record('base', clock.t, [row('0xnew')], 0.5);
  samples.close();
  samples = open(); t.after(() => samples.close());
  assert.equal(samples.status().available, true);
  assert.deepEqual(Object.keys(samples.read('30d').pools), ['base:0xnew']);
  assert.throws(() => samples.read('1y'), /unknown_window/);
});

test('an unreadable or newer sample database disables averages without throwing or touching the file', (t) => {
  const { dir, clock, open } = fixture(t);
  mkdirSync(join(dir, 'samples.sqlite'));
  const broken = open();
  assert.equal(broken.status().available, false); assert.ok(broken.status().error);
  broken.record('base', clock.t, [row('0xp')], 0.5);
  assert.deepEqual(broken.read('7d'), { window: '7d', available: false, error: broken.status().error, version: 0, pools: {} });
  broken.close();
  rmSync(join(dir, 'samples.sqlite'), { recursive: true });
  const future = new DatabaseSync(join(dir, 'samples.sqlite')); future.exec('PRAGMA user_version=2; CREATE TABLE keep (x)'); future.close();
  const newer = open();
  assert.equal(newer.status().available, false); assert.match(newer.status().error, /版本 2/);
  newer.close();
  assert.equal(existsSync(join(dir, 'samples.sqlite-wal')), false, 'a rejected database is not switched to WAL');
  const check = new DatabaseSync(join(dir, 'samples.sqlite'));
  assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 2);
  assert.ok(check.prepare("SELECT name FROM sqlite_master WHERE name = 'keep'").get());
  check.close();
});
