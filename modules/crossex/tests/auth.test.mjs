import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthenticator } from '../server/auth.mjs';

const basic = password => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const result = promise => promise.then(value => ({ value }), error => ({ error }));

function fixture(verify) {
  let now = 0, record = 'first';
  const calls = [], sleeps = [], pending = [];
  const auth = createAuthenticator({
    getRecord: () => record, clock: () => now,
    verify: async (password, passwordRecord) => { calls.push({ password, record: passwordRecord, at: now }); return verify ? verify(password, passwordRecord) : password === 'correct'; },
    sleep: ms => { sleeps.push(ms); return new Promise(resolve => pending.push({ due: now + ms, resolve })); },
  });
  return { auth, calls, sleeps, setRecord(value) { record = value; }, async advance(ms) {
    now += ms;
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].due <= now) pending.splice(i, 1)[0].resolve();
    await flush();
  } };
}

async function failTen(f) {
  for (let i = 0; i < 9; i++) assert.equal(await f.auth.authenticate(basic(`incorrect-${i}`)), false);
  await assert.rejects(f.auth.authenticate(basic('incorrect-9')), error => error.status === 429);
  assert.equal(f.sleeps.length, 0);
}

test('repeated credentials cannot reach verification before their reserved delay', async () => {
  const f = fixture(); await failTen(f);
  const pending = result(f.auth.authenticate(basic('incorrect-9')));
  assert.equal(f.calls.length, 10); assert.deepEqual(f.sleeps, [1000]);
  await f.advance(999); assert.equal(f.calls.length, 10);
  await f.advance(1); assert.equal(f.calls.length, 11); assert.equal((await pending).error.status, 429);
  const again = result(f.auth.authenticate(basic('incorrect-9')));
  await f.advance(999); assert.equal(f.calls.length, 11);
  await f.advance(1); assert.equal((await again).error.status, 429); assert.equal(f.calls.at(-1).at, 2000);
});

test('concurrent attempts reserve distinct slots and the bounded queue includes all waits', async () => {
  const f = fixture(); await failTen(f);
  const pending = Array.from({ length: 4 }, (_, i) => result(f.auth.authenticate(basic(`queued-${i}`))));
  assert.deepEqual(f.sleeps, [1000, 2000, 3000, 4000]);
  await assert.rejects(f.auth.authenticate(basic('overflow')), error => error.status === 429 && /繁忙/.test(error.message));
  assert.equal(f.calls.length, 10);
  for (let i = 0; i < 4; i++) {
    await f.advance(1000);
    assert.equal(f.calls.length, 11 + i); assert.equal(f.calls.at(-1).at, (i + 1) * 1000); assert.equal((await pending[i]).error.status, 429);
  }
  assert.equal(f.calls.some(call => call.password === 'overflow'), false);
});

test('late timer delivery cannot collapse reserved slots into a verification burst', async () => {
  const f = fixture(); await failTen(f);
  const pending = Array.from({ length: 4 }, (_, i) => result(f.auth.authenticate(basic(`late-${i}`))));
  await f.advance(4000); assert.equal(f.calls.length, 11);
  for (let i = 0; i < 3; i++) { await f.advance(1000); assert.equal(f.calls.length, 12 + i); }
  assert.deepEqual(f.calls.slice(10).map(call => call.at), [4000, 5000, 6000, 7000]);
  await Promise.all(pending);
});

test('password derivations retain their slots until completion', async () => {
  const finishes = [], f = fixture(() => new Promise(resolve => finishes.push(resolve)));
  const pending = Array.from({ length: 4 }, (_, i) => f.auth.authenticate(basic(`derive-${i}`)));
  assert.equal(f.calls.length, 4);
  await assert.rejects(f.auth.authenticate(basic('overflow')), error => error.status === 429 && /繁忙/.test(error.message));
  assert.equal(f.calls.length, 4);
  for (const finish of finishes) finish(false);
  assert.deepEqual(await Promise.all(pending), [false, false, false, false]);
});

test('uncached correct credentials succeed within the fourth slot and reset the delay', async () => {
  const f = fixture(); await failTen(f);
  const rejected = Array.from({ length: 3 }, (_, i) => result(f.auth.authenticate(basic(`bad-${i}`))));
  const correct = f.auth.authenticate(basic('correct'));
  for (let i = 0; i < 4; i++) await f.advance(1000);
  assert.equal(await correct, true); assert.equal(f.calls.at(-1).at, 4000);
  for (const pending of rejected) assert.equal((await pending).error.status, 429);
  const sleeps = f.sleeps.length;
  assert.equal(await f.auth.authenticate(basic('next-bad')), false); assert.equal(f.sleeps.length, sleeps);
});

test('cached correct credentials bypass the throttle and a full queue without deriving', async () => {
  const f = fixture(); assert.equal(await f.auth.authenticate(basic('correct')), true);
  await failTen(f);
  const pending = Array.from({ length: 4 }, (_, i) => result(f.auth.authenticate(basic(`bad-${i}`))));
  const count = f.calls.length, sleeps = f.sleeps.length;
  assert.equal(await f.auth.authenticate(basic('correct')), true); assert.equal(f.calls.length, count); assert.equal(f.sleeps.length, sleeps);
  for (let i = 0; i < 4; i++) await f.advance(1000);
  await Promise.all(pending);
});

test('fifteen-minute expiry resets the failure window before verification', async () => {
  const f = fixture(); await failTen(f); await f.advance(900000);
  assert.equal(await f.auth.authenticate(basic('still-wrong')), false); assert.equal(f.sleeps.length, 0); assert.equal(f.calls.length, 11);
});

test('password reset cancels queued old records before they can derive', async () => {
  const f = fixture(); await failTen(f);
  const old = f.auth.authenticate(basic('correct'));
  f.setRecord('second'); f.auth.reset();
  assert.equal(await f.auth.authenticate(basic('correct')), true);
  await f.advance(1000);
  assert.equal(await old, false); assert.equal(f.calls.length, 11); assert.equal(f.calls.at(-1).record, 'second');
  assert.equal(await f.auth.authenticate(basic('correct')), true); assert.equal(f.calls.length, 11);
});

test('in-flight old results cannot populate a new cache or poison new failure counts', async () => {
  for (const oldAccepted of [false, true]) {
    let finish;
    const f = fixture((password, record) => record === 'first' ? new Promise(resolve => { finish = resolve; }) : password === 'new-correct');
    const old = f.auth.authenticate(basic('old-correct'));
    f.setRecord('second');
    assert.equal(await f.auth.authenticate(basic('new-correct')), true);
    finish(oldAccepted); assert.equal(await old, false);
    const count = f.calls.length;
    assert.equal(await f.auth.authenticate(basic('new-correct')), true); assert.equal(f.calls.length, count);
    for (let i = 0; i < 9; i++) assert.equal(await f.auth.authenticate(basic(`new-bad-${i}`)), false);
    await assert.rejects(f.auth.authenticate(basic('old-correct')), error => error.status === 429);
    assert.equal(f.calls.at(-1).record, 'second');
  }
});

test('alternate Basic representations cannot bypass throttle; wrong usernames hold no queue slots', async () => {
  const f = fixture(); await failTen(f);
  const alternate = result(f.auth.authenticate(`${basic('incorrect-9')}\n`));
  const otherUser = result(f.auth.authenticate(`Basic ${Buffer.from('other:correct').toString('base64')}`));
  await f.advance(999); assert.equal(f.calls.length, 10);
  await f.advance(1); assert.equal(f.calls.length, 11); assert.equal((await alternate).error.status, 429);
  await f.advance(1000); assert.equal((await otherUser).error.status, 429); assert.equal(f.calls.length, 11);
  for (const value of ['', 'Bearer token', 'Basic '.padEnd(2049, 'A')]) assert.equal(await f.auth.authenticate(value), false);
});

test('reset immediately releases a full queue without releasing real in-flight derivations', async () => {
  const f = fixture(); await failTen(f);
  const old = Array.from({ length: 4 }, (_, i) => f.auth.authenticate(basic(`old-queued-${i}`)));
  f.setRecord('second'); f.auth.reset();
  assert.equal(await f.auth.authenticate(basic('correct')), true);
  assert.deepEqual(await Promise.all(old), [false, false, false, false]);
  assert.equal(f.calls.length, 11);
  let finishes = [];
  const busy = fixture(() => new Promise(resolve => finishes.push(resolve)));
  const running = Array.from({ length: 4 }, (_, i) => busy.auth.authenticate(basic(`running-${i}`)));
  busy.setRecord('second'); busy.auth.reset();
  await assert.rejects(busy.auth.authenticate(basic('correct')), error => error.status === 429);
  for (const finish of finishes) finish(false);
  assert.deepEqual(await Promise.all(running), [false, false, false, false]);
});
