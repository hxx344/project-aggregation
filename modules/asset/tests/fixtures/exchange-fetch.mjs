// Production smoke only: injected with Node --import; never loaded by the app itself.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHmac } from 'node:crypto';
import { verifyTypedData } from 'ethers';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const flag = name => existsSync(join(process.env.ASSET_DATA_DIR, name));
const variationalFixture = () => flag('variational-fixture.json') ? JSON.parse(readFileSync(join(process.env.ASSET_DATA_DIR, 'variational-fixture.json'), 'utf8')) : {};
const realFetch = globalThis.fetch;
const realSpawn = childProcess.spawn;
const pythonFixture = fileURLToPath(new URL('./variational-python-fixture.py', import.meta.url));
childProcess.spawn = (command, args, options) => {
  if (!Array.isArray(args) || basename(args[2] ?? '') !== 'variational-diagnostic.py') return realSpawn(command, args, options);
  assert.equal(command, process.platform === 'win32' ? 'python' : 'python3');
  assert.deepEqual(args, ['-I', '-B', resolve('scripts/variational-diagnostic.py')]);
  assert.ok(isAbsolute(args[2]) && existsSync(args[2]), 'The production runtime must include the Python helper');
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
  return realSpawn(command, ['-I', '-B', pythonFixture, args[2], join(process.env.ASSET_DATA_DIR, 'variational-fixture.json')], options);
};
syncBuiltinESMExports();
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const diagnosticFixture = variationalFixture();
  if (diagnosticFixture.diagnosticOnly) {
    const allowed = ['https://omni.variational.io/api/me', 'https://omni.variational.io/api/portfolio?compute_margin=true'].includes(url.href);
    appendFileSync(join(process.env.ASSET_DATA_DIR, 'variational-diagnostic-requests.jsonl'), JSON.stringify({ client: 'asset-node', path: allowed ? url.pathname + url.search : 'unexpected-endpoint' }) + '\n');
    assert.ok(allowed, 'Diagnostics cannot contact pricing, trading or other endpoints');
  }
  if (url.hostname === 'omni.variational.io') {
    if (!diagnosticFixture.diagnosticOnly) {
      appendFileSync(join(process.env.ASSET_DATA_DIR, 'variational-sync-requests.jsonl'), JSON.stringify({ client: 'asset-node', path: url.pathname + url.search, operation: 'unexpected-node' }) + '\n');
      assert.fail('Formal Variational connections and refreshes must use Python portfolio only');
    }
    assert.ok(['https://omni.variational.io/api/me', 'https://omni.variational.io/api/portfolio?compute_margin=true'].includes(url.href));
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    const headers = new Headers(init.headers);
    const cookie = headers.get('cookie');
    assert.ok(['vr-token=synthetic-var-token', 'vr-token=synthetic-var-token-replacement'].includes(cookie));
    assert.deepEqual(Object.fromEntries(headers), {
      accept: 'application/json',
      'cache-control': 'no-cache',
      cookie,
      referer: 'https://omni.variational.io/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
    });
    const fixture = url.pathname === '/api/me' ? diagnosticFixture.session ?? {} : diagnosticFixture;
    const status = fixture.status ?? (fixture.failure === true ? 503 : fixture.failure || 200);
    if (fixture.challenge || fixture.html) {
      return new Response(`<!doctype html><title>${fixture.challenge ? 'Just a moment' : 'Upstream page'}</title><p>${cookie}</p>`, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...(fixture.challenge ? { 'cf-mitigated': 'challenge', server: 'cloudflare' } : {}) },
      });
    }
    if (fixture.failure || status >= 400) return Response.json({ error: cookie }, { status });
    if (url.pathname === '/api/me') return Response.json(fixture.payload ?? { token: 'synthetic-var-returned-token', account: 'PRIVATE_DIAGNOSTIC_ACCOUNT' });
    return Response.json(fixture.portfolio ?? { balance: fixture.balance ?? '125', upnl: '9000', margin: '8000', sub_accounts: [{ balance: '7000' }] });
  }
  if (url.hostname === 'api.coinbase.com') {
    assert.equal(new Headers(init.headers).get('cookie'), null, 'Pricing providers must never receive a session cookie');
    if (url.searchParams.get('currency') === 'USDC') {
      assert.equal(url.href, 'https://api.coinbase.com/v2/exchange-rates?currency=USDC');
      assert.equal(init.method, 'GET');
      const fixture = variationalFixture();
      return fixture.coinbaseFailure ? new Response('', { status: 503 }) : Response.json({ data: { currency: 'USDC', rates: { USD: String(fixture.coinbaseRate ?? '1') } } });
    }
    if (flag('fx-ordering')) {
      const deadline = Date.now() + 3000;
      while (!flag('account-before-fx') && Date.now() < deadline) await delay(10);
      assert.ok(flag('account-before-fx'), 'Account reads must start before the delayed FX result');
    }
    return flag('fx-failure') ? new Response('', { status: 503 }) : Response.json({ data: { currency: 'USD', rates: { CNY: '7.1234', ...(flag('market-failure') ? {} : { VIRTUAL: '1', USDT: '1', USDC: '1' }) } } });
  }
  if (url.hostname === 'api.frankfurter.dev') return flag('fx-failure') ? new Response('', { status: 503 }) : Response.json({ base: 'USD', quote: 'CNY', rate: 7.11, date: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
  if (url.hostname === 'api.coingecko.com') {
    assert.equal(new Headers(init.headers).get('cookie'), null, 'Pricing providers must never receive a session cookie');
    if (url.searchParams.get('ids') === 'usd-coin') {
      assert.equal(url.href, 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd&include_last_updated_at=true');
      assert.equal(init.method, 'GET');
      const fixture = variationalFixture();
      return fixture.geckoFailure ? new Response('', { status: 503 }) : Response.json({ 'usd-coin': { usd: fixture.quote ?? 1, last_updated_at: fixture.quoteAt ?? Math.floor(Date.now() / 1000) } });
    }
    return flag('market-failure') ? Response.json({}) : Response.json(Object.fromEntries(
      ['virtual-protocol', 'tether', 'usd-coin'].map(id => [id, { usd: 1, last_updated_at: Math.floor(Date.now() / 1000) }]),
    ));
  }
  if (url.hostname === 'api.binance.com') {
    assert.equal(init.method,'GET');
    assert.equal(init.redirect,'manual');
    assert.equal(new Headers(init.headers).get('X-MBX-APIKEY'),'synthetic-binance-key');
    const signature=url.searchParams.get('signature');
    url.searchParams.delete('signature');
    assert.equal(signature,createHmac('sha256','synthetic-binance-secret').update(url.search.slice(1)).digest('hex'));
    assert.equal(url.href.includes('synthetic-binance-secret'),false);
    const fixture=flag('binance-fixture.json')?JSON.parse(readFileSync(join(process.env.ASSET_DATA_DIR,'binance-fixture.json'),'utf8')):{};
    if (url.pathname === '/sapi/v1/account/apiRestrictions') return Response.json({enableReading:true,enableWithdrawals:false,enableInternalTransfer:false,enableMargin:false,enableFutures:false,permitsUniversalTransfer:false,enableVanillaOptions:false,enableSpotAndMarginTrading:false,enableFixApiTrade:false,enablePortfolioMarginTrading:false,...fixture.permissions});
    if (url.pathname === '/sapi/v1/asset/wallet/balance') {
      assert.equal(url.searchParams.get('quoteAsset'),'USDT');
      if(fixture.failure)return new Response('',{status:503});
      return Response.json(fixture.wallets??[{activate:true,walletName:'Spot',balance:'100'},{activate:true,walletName:'Funding',balance:'25'}]);
    }
    throw new Error('Unexpected Binance route in test');
  }
  if (url.hostname === 'openapi.okx.com') {
    assert.equal(url.origin, 'https://openapi.okx.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    const apiKey = headers.get('OK-ACCESS-KEY');
    const replacement = apiKey === 'synthetic-okx-key-replacement';
    assert.equal(apiKey, replacement ? 'synthetic-okx-key-replacement' : 'synthetic-okx-key');
    const apiSecret = replacement ? 'synthetic-okx-secret-replacement' : 'synthetic-okx-secret';
    const passphrase = replacement ? 'synthetic-okx-passphrase-replacement' : 'synthetic-okx-passphrase';
    assert.equal(headers.get('OK-ACCESS-PASSPHRASE'), passphrase);
    const timestamp = headers.get('OK-ACCESS-TIMESTAMP');
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(Date.now() - Date.parse(timestamp)) < 30000);
    assert.equal(headers.get('OK-ACCESS-SIGN'), createHmac('sha256', apiSecret).update(timestamp + 'GET' + url.pathname + url.search).digest('base64'));
    for (const secret of [apiKey, apiSecret, passphrase]) assert.equal(url.href.includes(secret), false);
    const fixture = flag('okx-fixture.json') ? JSON.parse(readFileSync(join(process.env.ASSET_DATA_DIR, 'okx-fixture.json'), 'utf8')) : {};
    if (url.pathname === '/api/v5/account/config') {
      assert.equal(url.search, '');
      return Response.json({ code: '0', data: [{ perm: fixture.permissions ?? 'read_only' }] });
    }
    if (url.pathname === '/api/v5/asset/asset-valuation') {
      assert.equal(url.search, '?ccy=USD');
      if (fixture.failure) return new Response('', { status: 503 });
      return Response.json({ code: '0', data: [{ totalBal: fixture.total ?? '321.5', ts: String(fixture.ts ?? Date.now()), details: fixture.details ?? { funding: '20', trading: '100', earn: '200' } }] });
    }
    throw new Error('Unexpected OKX route in test');
  }
  if (url.hostname === 'api.bybit.com') {
    if (url.pathname === '/v5/user/query-api') {
      if (flag('fx-ordering')) writeFileSync(join(process.env.ASSET_DATA_DIR, 'account-before-fx'), 'fixture');
      // A serial Bybit -> Aster refresh cannot release this gate. This checks
      // actual provider overlap without relying on wall-clock speed assertions.
      if (flag('exchange-concurrency')) {
        const deadline = Date.now() + 3000;
        while (!flag('aster-started') && Date.now() < deadline) await delay(10);
        assert.ok(flag('aster-started'), 'Aster must start before Bybit finishes');
      }
      return Response.json({ retCode: 0, result: { readOnly: 1 } });
    }
    if (url.pathname === '/v5/account/wallet-balance') return Response.json({ retCode: 0, result: { list: [{ accountType: 'UNIFIED', totalEquity: '75', coin: [] }] } });
    if (url.pathname === '/v5/asset/transfer/query-account-coins-balance') return Response.json({ retCode: 0, result: { balance: [] } });
    throw new Error('Unexpected Bybit route in test');
  }
  if (['fapi.asterdex.com', 'sapi.asterdex.com'].includes(url.hostname)) {
    if (flag('exchange-concurrency')) writeFileSync(join(process.env.ASSET_DATA_DIR, 'aster-started'), 'fixture');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    const signature = url.searchParams.get('signature');
    url.searchParams.delete('signature');
    assert.deepEqual([...url.searchParams.keys()], ['nonce', 'signer']);
    assert.equal(verifyTypedData(
      { name: 'AsterSignTransaction', version: '1', chainId: 1666, verifyingContract: '0x0000000000000000000000000000000000000000' },
      { Message: [{ name: 'msg', type: 'string' }] }, { msg: url.search.slice(1) }, signature,
    ), url.searchParams.get('signer'));
    const accounts=flag('aster-fixtures.json')?JSON.parse(readFileSync(join(process.env.ASSET_DATA_DIR,'aster-fixtures.json'),'utf8')):{};
    const account=accounts[url.searchParams.get('signer').toLowerCase()];
    if(account?.failure)return new Response('',{status:503});
    if (url.hostname === 'fapi.asterdex.com' && url.pathname === '/fapi/v3/accountWithJoinMargin') return Response.json({ assets: [{ asset: 'USDT', marginBalance: String(account?.total??125) }] });
    if (url.hostname === 'sapi.asterdex.com' && url.pathname === '/api/v3/account') return Response.json({ balances: [{ asset: 'USDC', free: '20', locked: '5' }] });
    throw new Error('Unexpected Aster route in test');
  }
  return realFetch(input, init);
};
