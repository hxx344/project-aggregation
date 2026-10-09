import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import { createUpdateStream } from '../server/update-stream.mjs';
import { unavailableUpdateState } from '../server/updates.mjs';

class Response extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  messages = [];
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(value) { this.messages.push(value); }
  end() { this.destroyed = true; this.emit('close'); }
  destroy() { this.end(); }
  snapshots() { return this.messages.filter(value => value.includes('"snapshot"')).map(value => JSON.parse(value.slice(6))); }
}
const value = () => ({ ...unavailableUpdateState(), enabled: true });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('all subscribers share one read; unchanged polls send no snapshot and last disconnect stops polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0, state = value();
  const gate = deferred();
  const stream = createUpdateStream({ readState: async () => { calls++; if (calls === 1) await gate.promise; return state; }, isSessionActive: () => true });
  t.after(() => stream.close());
  const one = new Response(), two = new Response();
  stream.subscribe(one, 'session'); stream.subscribe(two, 'session');
  assert.equal(calls, 1); gate.resolve(); await turn();
  assert.equal(one.snapshots().length, 1); assert.equal(two.snapshots().length, 1);
  t.mock.timers.tick(5000); await turn();
  assert.equal(calls, 2); assert.equal(one.snapshots().length, 1);
  state = { ...state, checking: true, privateLog: 'secret' };
  t.mock.timers.tick(5000); await turn();
  assert.equal(one.snapshots().at(-1).state.checking, true);
  assert.equal(one.messages.join('').includes('secret'), false);
  t.mock.timers.tick(2000); await turn(); assert.equal(calls, 4);
  one.end(); two.end(); t.mock.timers.tick(30000); await turn(); assert.equal(calls, 4);
});

test('refresh after a mutation discards an earlier pending state and reads again without overlap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  const gate = deferred(), state = { ...value(), checking: true };
  const stream = createUpdateStream({ readState: async () => ++calls === 1 ? gate.promise : state, isSessionActive: () => true });
  t.after(() => stream.close());
  const res = new Response(); stream.subscribe(res, 'session');
  const refresh = stream.refresh(); assert.equal(calls, 1);
  gate.resolve(value()); await refresh; assert.equal(res.snapshots().length, 0);
  t.mock.timers.tick(0); await turn();
  assert.equal(calls, 2); assert.equal(res.snapshots().at(-1).state.checking, true);
});

test('heartbeat rechecks sessions, limits connections, disconnects slow readers and cleans close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let allowed = true;
  const stream = createUpdateStream({ readState: async () => value(), isSessionActive: () => allowed });
  const clients = Array.from({ length: 12 }, () => new Response());
  for (const res of clients) stream.subscribe(res, 'session');
  assert.throws(() => stream.subscribe(new Response(), 'session'), error => error.status === 429);
  await turn();
  clients[0].writableLength = 300000;
  stream.revalidate(); assert.equal(clients[0].destroyed, true);
  assert.ok(clients[1].messages.some(message => message.includes('"heartbeat"')));
  allowed = false; stream.revalidate(); assert.ok(clients.every(res => res.destroyed));
  await stream.close();
  assert.throws(() => stream.subscribe(new Response(), 'session'), error => error.status === 503);
});

test('close waits for the shared read and prevents sends or timers after shutdown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const gate = deferred(); let calls = 0;
  const stream = createUpdateStream({ readState: () => { calls++; return gate.promise; }, isSessionActive: () => true });
  const res = new Response(); stream.subscribe(res, 'session');
  let finished = false; const close = stream.close().then(() => { finished = true; });
  await turn(); assert.equal(finished, false); assert.equal(res.destroyed, true);
  gate.resolve(value()); await close;
  t.mock.timers.tick(60000); await turn();
  assert.equal(calls, 1); assert.equal(res.snapshots().length, 0);
});
