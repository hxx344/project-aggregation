import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, createRequestSlot } from '../lib/client-request.ts';
import { nextLedgerExpiry } from '../lib/client-freshness.ts';
import type { Asset, FxStatus } from '../lib/types.ts';

test('deadline covers stalled headers and body; writes are never automatically repeated', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const bodyHangs of [false, true]) {
    let calls=0, signal:AbortSignal|undefined;
    t.mock.method(globalThis,'fetch',async (_:unknown,options:RequestInit)=>{
      calls++;signal=options.signal!;
      return bodyHangs?{ok:true,json:()=>new Promise(()=>{})}:new Promise(()=>{});
    });
    const result=requestJson('/api/ledger',{method:'PATCH',timeoutMs:100});
    const rejected=assert.rejects(result,{name:'TimeoutError'});
    await Promise.resolve();t.mock.timers.tick(100);await rejected;
    assert.equal(calls,1);assert.equal(signal!.aborted,true);t.mock.restoreAll();
  }
});

test('inactive automatic read is released immediately; old completion cannot unlock a newer save', async()=>{
  const slot=createRequestSlot(),old=slot.start(true)!;
  assert.equal(slot.start(),null);assert.equal(slot.cancel(true),true);assert.equal(old.signal.aborted,true);
  const save=slot.start()!;assert.equal(slot.finish(old),false);assert.equal(slot.cancel(true),false);assert.equal(save.signal.aborted,false);
  assert.equal(slot.start(),null);assert.equal(slot.finish(save),true);
  const manual=slot.start()!;slot.cancel();assert.equal(manual.signal.aborted,true);
});

test('aborting an automatic read releases a transport that never settles',async t=>{
  t.mock.method(globalThis,'fetch',()=>new Promise(()=>{}));
  const controller=new AbortController();
  const pending=requestJson('/api/sync',{signal:controller.signal,timeoutMs:75_000});
  controller.abort();await assert.rejects(pending,{name:'AbortError'});
});

test('stale status advances at source expiry without waiting for a sync response',()=>{
  const asset={mode:'bybit',updatedAt:new Date(0).toISOString(),status:'只读同步'} as Asset;
  const ledger={assets:[asset,{...asset,mode:'manual' as const}],fxStatus:{fetchedAt:new Date(10000).toISOString(),error:null} as FxStatus};
  assert.equal(nextLedgerExpiry(ledger,100000),300001);
  assert.equal(nextLedgerExpiry(ledger,300001),310001);
  assert.equal(nextLedgerExpiry(ledger,310001),null);
});
