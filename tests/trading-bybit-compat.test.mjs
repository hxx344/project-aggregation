import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTrading } from '../server/trading.mjs';
import { createTradingExchangeClient } from '../server/trading-exchanges.mjs';

test('Bybit compatibility survives runtime persistence and field diagnostics survive restart', async () => {
  const db = new DatabaseSync(':memory:');
  let current = Date.UTC(2025, 1, 7, 12), malformed = false;
  const options = {
    db, encrypt: value => JSON.stringify(value), decrypt: value => JSON.parse(value), intervalMs: 0, now: () => current,
    clientFactory: exchange => createTradingExchangeClient(exchange, {
      now: () => current,
      fetchImpl: async address => {
        const url = new URL(address);
        let result;
        if (url.pathname.endsWith('query-api')) result = { readOnly: 1 };
        else if (url.pathname.endsWith('/info')) result = { unifiedMarginStatus: 6 };
        else if (url.pathname.endsWith('position/list')) result = { category: 'linear', list: [], nextPageCursor: '' };
        else if (url.pathname.endsWith('transaction-log')) {
          const baseCoin = url.searchParams.get('baseCoin'), time = current - 1;
          const rows = Number(url.searchParams.get('startTime')) <= time && Number(url.searchParams.get('endTime')) >= time
            ? [{ id: baseCoin + '/opaque+id=7', symbol: baseCoin + 'USDT', type: 'SETTLEMENT', category: 'linear', transactionTime: String(time), currency: 'USDT', funding: malformed ? null : baseCoin === 'CL' ? '1E-8' : '-2.5E-8' }]
            : [];
          result = { list: rows, nextPageCursor: null };
        } else throw new Error('Unexpected fixture request');
        return new Response(JSON.stringify({ retCode: 0, result }), { headers: { 'Content-Type': 'application/json' } });
      },
    }),
  };
  let trading = createTrading(options);
  try {
    await trading.connect('bybit', { revision: 0, apiKey: 'fixture_only_key', apiSecret: 'fixture_only_secret' });
    await trading.refresh();
    const state = trading.state();
    assert.equal(state.accounts[1].funding.complete, true);
    assert.equal(state.funding.net, '-0.000000015');
    assert.equal(state.funding.events.length, 2);
    assert.ok(state.funding.events.every(row => row.id.includes('/opaque+id=7')));
    await trading.close(); trading = createTrading(options);
    assert.deepEqual(trading.state().funding, state.funding);

    malformed = true; current += 6000;
    await trading.refresh({ force: true });
    const failure = trading.state().accounts[1].funding;
    assert.equal(failure.complete, false);
    assert.match(failure.error, /字段 funding.*空值/);
    assert.equal(trading.state().funding.events.length, 2);
    const saved = JSON.parse(db.prepare("SELECT snapshot FROM trading_accounts WHERE exchange='bybit'").get().snapshot);
    assert.equal(saved.funding.diagnostic.field, 'funding');
    assert.equal(saved.funding.diagnostic.valueType, 'null');
    assert.equal(JSON.stringify(saved).includes('fixture_only_secret'), false);
    await trading.close(); trading = createTrading(options);
    assert.equal(trading.state().accounts[1].funding.error, failure.error);
  } finally { await trading.close(); db.close(); }
});
