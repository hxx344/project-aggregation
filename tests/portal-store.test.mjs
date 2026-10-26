import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openHubDatabase } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { createPortalStore } from '../server/control/portal-store.mjs';

// Two API instances: separate connections to one hub.sqlite.
async function instances(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-store-'));
  const dbs = [0, 1].map(() => openHubDatabase(path.join(dir, 'hub.sqlite')));
  t.after(async () => { for (const db of dbs) db.close(); await rm(dir, { recursive: true, force: true }); });
  return dbs.map(db => createPortalStore(createControlStore(db)));
}

const ticket = expires => ({ projectId: 'asset', sessionId: 'session', revision: 'one', destination: '/', expires });

test('a ticket goes to one taker, only for its project and only before it expires', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  assert.equal(a.issueTicket('t1', ticket(now + 1000), now, 300), true);
  assert.equal(b.takeTicket('t1', 'monitor', now), null);
  assert.deepEqual(b.takeTicket('t1', 'asset', now), ticket(now + 1000));
  assert.equal(a.takeTicket('t1', 'asset', now), null);
  a.issueTicket('t2', ticket(now + 1000), now, 300);
  assert.equal(b.takeTicket('t2', 'asset', now + 1000), null);
});

test('the limit counts unexpired rows of every instance and grants held in process', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  assert.equal(a.issueTicket('t1', ticket(now + 1000), now, 2), true);
  assert.equal(b.issueTicket('t2', ticket(now + 1000), now, 2), true);
  assert.equal(a.issueTicket('t3', ticket(now + 1000), now, 2), false);
  assert.equal(a.issueTicket('t3', ticket(now + 2000), now + 1000, 2), true);
  assert.equal(a.issueGrant('g1', ticket(now + 5000), now, 2), true);
  assert.equal(b.issueGrant('g2', ticket(now + 5000), now, 2, 1), false);
  assert.equal(b.issueTicket('t4', ticket(now + 5000), now + 1000, 3, 2), false);
  assert.deepEqual(b.grant('g1'), { projectId: 'asset', sessionId: 'session', revision: 'one', expires: now + 5000, digest: 'g1' });
  b.revokeGrants(['g1']);
  assert.equal(a.grant('g1'), null);
});

test('pruning deletes expired rows only', async t => {
  const [a, b] = await instances(t);
  const now = Date.now();
  a.issueTicket('old', ticket(now), now - 1, 300);
  a.issueTicket('new', ticket(now + 1), now - 1, 300);
  a.issueGrant('old', ticket(now), now - 1, 300);
  a.issueGrant('new', ticket(now + 1), now - 1, 300);
  b.prune(now);
  assert.deepEqual(a.grants().map(item => item.digest), ['new']);
  assert.equal(a.takeTicket('old', 'asset', now - 1), null);
  assert.ok(a.takeTicket('new', 'asset', now));
});
