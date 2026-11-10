import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createPositionFunding } from '../server/position-funding.mjs';

const EPOCH = 1_800_000_000_000, TICK = 2000, DELAY = 6000;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(count) {
  let now = EPOCH, active = 0, maximum = 0, limited = false, fail = false;
  const pending = [], attempts = [], covered = new Set();
  const symbols = Array.from({ length: count }, (_, i) => `${i % 2 ? 'OKX' : 'BINANCE'}_FUTURE_S${i}_USDT`);
  const funding = createPositionFunding({ clock: () => now,
    identityReader: async symbol => ({ symbol, exchange: symbol.split('_')[0].toLowerCase() }),
    currentReader: quote => {
      attempts.push({ symbol: quote.symbol, at: now }); active++; maximum = Math.max(maximum, active);
      return new Promise((resolve, reject) => pending.push({ at: now, finish() {
        active--;
        if (limited && quote.exchange === 'binance') { reject(Object.assign(new Error('fixture limit'), { status: 429 })); return; }
        if (fail) { reject(new Error('fixture unavailable')); return; }
        covered.add(quote.symbol); resolve({ rate: '0.0001', intervalHours: 8, sourceAt: now, nextFundingAt: now + 3_600_000 });
      } }));
    } });
  return { symbols, attempts, covered, funding, get now() { return now; }, get maximum() { return maximum; },
    limited(value) { limited = value; }, fail(value) { fail = value; }, jump(ms) { now += ms; },
    async tick() {
      funding.rates(symbols); await flush(); now += TICK;
      for (const entry of [...pending]) if (now - entry.at >= DELAY) { pending.splice(pending.indexOf(entry), 1); entry.finish(); }
      await flush();
    },
    async stop() { pending.splice(0).forEach(entry => entry.finish()); await flush(); await funding.stop(); },
  };
}

for (const count of [8, 64, 256]) test(`funding controlled scale ${count}: coverage, cooldown, expiry and rollback`, async t => {
  const started = performance.now(), f = harness(count); t.after(() => f.stop());
  const budget = Math.ceil(count / 4) * DELAY;
  for (let elapsed = 0; elapsed < budget && f.covered.size < count; elapsed += TICK) await f.tick();
  assert.equal(f.covered.size, count, 'every legal holding gets a first turn within the derived four-reader budget');
  assert.equal(f.attempts.length, count, 'oldest-turn ordering prioritizes every unread holding before repeats');
  assert.equal(f.maximum, 4);
  const coverageMs = f.now - EPOCH;

  // Only the venue that returned a limit is paused. Observe the starts, not merely the output cache.
  f.jump(30_000); f.limited(true); const firstLimitAttempt = f.attempts.length;
  for (let i = 0; i < DELAY / TICK; i++) await f.tick();
  const cooldownAt = f.now, boundary = f.attempts.length;
  for (let i = 0; i < (60_000 - DELAY) / TICK; i++) await f.tick();
  assert.ok(f.attempts.slice(boundary).some(row => row.symbol.startsWith('OKX_')));
  assert.ok(f.attempts.slice(boundary).every(row => !row.symbol.startsWith('BINANCE_')));
  f.limited(false);
  const resumeBoundary = f.attempts.length;
  for (let i = 0; i < count * DELAY / TICK; i++) {
    await f.tick();
    if (f.attempts.slice(resumeBoundary).some(row => row.symbol.startsWith('BINANCE_'))) break;
  }
  const resumed = f.attempts.slice(resumeBoundary).find(row => row.symbol.startsWith('BINANCE_'));
  assert.ok(resumed); assert.ok(resumed.at >= cooldownAt + 60_000);
  assert.ok(resumed.at - cooldownAt <= 60_000 + budget);
  assert.ok(f.attempts.length > firstLimitAttempt);

  // Drain pending requests before moving the wall clock; no pending fixture waits depend on wall time.
  for (let i = 0; i < DELAY / TICK; i++) await f.tick();
  f.fail(true); f.jump(300_001);
  assert.deepEqual(f.funding.rates(f.symbols), [], 'expired source evidence is never extended by polling'); await flush();
  f.fail(false); f.covered.clear(); f.jump(-3_600_000);
  // Requests begun before rollback are completed as controlled I/O, independently of the wall clock.
  await f.stop();
  const rollback = harness(count); t.after(() => rollback.stop());
  for (let i = 0; i < budget / TICK; i++) await rollback.tick();
  rollback.covered.clear(); rollback.jump(-3_600_000);
  assert.deepEqual(rollback.funding.rates(rollback.symbols), [], 'future-stamped values are hidden after rollback');
  for (let i = 0; i < budget / TICK; i++) await rollback.tick();
  assert.equal(rollback.covered.size, count);
  assert.ok(rollback.funding.rates(rollback.symbols).every(row => row.fundingAt <= rollback.now + 1000 && row.expiresAt > rollback.now));
  assert.equal(rollback.maximum, 4);
  t.diagnostic(JSON.stringify({ scale: count, readerDelayMs: DELAY, pollMs: TICK, coverageMs, coverageRequests: count,
    maxInFlight: f.maximum, rateLimitRecoveryMs: resumed.at - cooldownAt, rollbackCoverageBudgetMs: budget,
    wallMs: Math.round((performance.now() - started) * 100) / 100, source: 'controlled-readers-no-network' }));
});
