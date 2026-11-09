import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createTrading } from '../server/trading.mjs';

test('OKX account proof stays with its cached Anthropic snapshot across restart and is cleared on reconnect', async t => {
  const db = new DatabaseSync(':memory:'), at = new Date().toISOString();
  const proof = uid => createHash('sha256').update(`okx:${uid}`).digest('hex');
  let uid = '42', hold = null;
  const factory = exchange => ({
    verify: async () => ({ fetchedAt: at, positions: [] }),
    positions: async () => ({ fetchedAt: at, positions: [] }),
    hynixPositions: async () => ({ fetchedAt: at, positions: [] }),
    funding: async (_credentials, { start, end }) => ({ fetchedAt: at, events: [], coverage: [{ start, end }], complete: true }),
    anthropicPositions: async () => {
      if (hold) await hold;
      return { fetchedAt: at, accountIdentity: proof(uid), positions: [{ exchange, symbol: 'ANTHROPICUSDT', mode: 'hedge', side: 'long', marginMode: 'cross', quantity: '10', contractSize: '1', markPrice: '100', liquidationPrice: '50' }] };
    },
  });
  const open = () => createTrading({ db, encrypt: JSON.stringify, decrypt: JSON.parse, clientFactory: factory, intervalMs: 0 });
  let trading = open(); t.after(async () => { await trading.close(); db.close(); });
  const connect = revision => trading.connect('okx', { revision, accountMode: 'unified', apiKey: 'fixture_key_' + revision, apiSecret: 'fixture_secret', passphrase: 'fixture_passphrase' });
  await connect(0); await trading.refresh();
  assert.equal(trading.anthropic().find(row => row.exchange === 'okx').accountIdentity, proof('42'));
  assert.equal(JSON.stringify(trading.state(7, { pair: ['binance', 'okx'] })).includes(proof('42')), false);
  await trading.close(); trading = open();
  assert.equal(trading.anthropic().find(row => row.exchange === 'okx').accountIdentity, proof('42'));
  let release; hold = new Promise(resolve => { release = resolve; }); uid = '43';
  await connect(1);
  const pending = trading.anthropic().find(row => row.exchange === 'okx');
  assert.equal(pending.accountIdentity, null); assert.deepEqual(pending.positions, []);
  release(); hold = null; await nextTurn(); await trading.refresh();
  assert.equal(trading.anthropic().find(row => row.exchange === 'okx').accountIdentity, proof('43'));
});
