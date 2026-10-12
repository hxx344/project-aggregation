import test from 'node:test';
import assert from 'node:assert/strict';
import { mapConcurrent, settleIndependent } from '../lib/concurrency.ts';

test('a delayed FX branch does not delay account reads; failure waits for remaining writes before releasing the lock', async()=>{
  let finishFx!:()=>void, finishAccount!:()=>void, accountStarted=false, complete=false;
  const fx=new Promise<void>(resolve=>{finishFx=resolve;});
  const account=new Promise<void>(resolve=>{finishAccount=resolve;});
  const pending=settleIndependent([
    async()=>{await Promise.resolve('prices');accountStarted=true;await account;},
    async()=>{await fx;throw new Error('FX persistence failed');},
  ]);
  const rejected=assert.rejects(pending,/FX persistence failed/).then(()=>{complete=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(accountStarted,true);
  finishFx();await new Promise(resolve=>setImmediate(resolve));assert.equal(complete,false);
  finishAccount();await rejected;assert.equal(complete,true);
});

test('account pool bounds simultaneous work, keeps ordering and isolates handled account failures', async () => {
  let running = 0, maximum = 0;
  const results = await mapConcurrent([0, 1, 2, 3, 4, 5, 6], 3, async index => {
    running++; maximum = Math.max(maximum, running);
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (index === 2) throw new Error('provider unavailable');
      return { value: index + 100, error: null };
    } catch (error) { return { value: index, error: (error as Error).message }; }
    finally { running--; }
  });
  assert.equal(maximum, 3);
  assert.equal(running, 0);
  assert.deepEqual(results.map(result => result.value), [100, 101, 2, 103, 104, 105, 106]);
  assert.equal(results[2].error, 'provider unavailable');
  assert.deepEqual(await mapConcurrent([], 3, async value => value), []);
  await assert.rejects(mapConcurrent([1], 0, async value => value));
});
