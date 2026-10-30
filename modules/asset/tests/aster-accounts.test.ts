import test from 'node:test';
import assert from 'node:assert/strict';
import {asterKey,readAsterAccounts,aggregateAster,mergeAsterRefresh} from '../lib/aster-accounts.ts';
import {asterAccountSchema,asterAccountDeleteSchema} from '../lib/validation.ts';
import {snapshotValues} from '../lib/asset-values.ts';
import type {Asset,AsterAccount,Connection} from '../lib/types.ts';
const asset:Asset={id:'row-1',project:'aster',kind:'资产',quantity:150,price:1,value:150,cell:'E1',mode:'aster',updatedAt:'2026-09-21T08:00:00+08:00',status:'只读同步'};
const connection:Connection={configured:true,lastSync:asset.updatedAt,error:null,scope:'API Pro · 合约 + 现货',label:'abcd'};
const legacy=()=>readAsterAccounts(undefined,['aster'],asset,connection);
test('legacy connection becomes default without changing value or ciphertext key',()=>{
  const accounts=legacy();assert.equal(accounts[0].id,'default');assert.equal(accounts[0].value,150);assert.equal(accounts[0].includeSpot,true);assert.equal(asterKey('default'),'aster');
  assert.deepEqual(readAsterAccounts('[]',[],asset,connection),[],'Explicit removal never resurrects a legacy balance');
  assert.deepEqual(readAsterAccounts(undefined,[],asset,{...connection,configured:false,lastSync:null}),[],'Workbook placeholder is not an account');
});
test('aggregation counts each account once and preserves oldest timestamp and partial state',()=>{
  const second:AsterAccount={...legacy()[0],id:crypto.randomUUID(),name:'二号',value:200,updatedAt:'2026-09-21T01:00:00Z',lastSync:'2026-09-21T01:00:00Z',details:[{account:'合约',coin:'USDT',price:1,quantity:200,value:200}]};
  const result=aggregateAster([{...legacy()[0],error:'同步失败'},second],asset,'2026-09-21T02:00:00Z');
  assert.equal(result.asset.value,350);assert.equal(result.asset.updatedAt,asset.updatedAt);assert.match(result.asset.error!,/默认账号/);assert.equal(result.asset.details![0].account,'二号 / 合约');assert.equal(result.connection.configured,true);
  const empty=aggregateAster([],asset,'2026-09-21T02:00:00Z');assert.equal(empty.asset.value,0);assert.equal(empty.connection.configured,false);
});
test('account schemas reject exchange/key confusion, injected owner and unbounded identifiers',()=>{
  const input={id:crypto.randomUUID(),name:'测试账号',walletAddress:'0x'+'1'.repeat(40),privateKey:'2'.repeat(64)};
  assert.equal(asterAccountSchema.parse(input).includeSpot,false);
  for(const invalid of [{id:'bybit'},{id:'../default'},{name:' '},{name:'x'.repeat(41)},{owner:'other'},{apiKey:'abc'},{url:'https://example.test'}])assert.throws(()=>asterAccountSchema.parse({...input,...invalid}));
  assert.throws(()=>asterAccountDeleteSchema.parse({id:'bybit',action:'remove'}));
});

test('legacy unknown Aster valuations remain null through aggregation and make snapshots partial',()=>{
  const now='2026-10-23T04:00:00Z',unknown={...asset,quantity:null,value:null,updatedAt:now};
  const accounts=readAsterAccounts(undefined,['aster'],unknown,{...connection,lastSync:now});
  assert.equal(accounts[0].value,null);
  assert.equal(JSON.parse(JSON.stringify(accounts))[0].value,null);
  const aggregate=aggregateAster(accounts,unknown,now);
  assert.equal(aggregate.asset.value,null);
  assert.equal(aggregate.asset.quantity,null);
  assert.match(aggregate.asset.error!,/默认账号：估值缺失/);
  assert.match(aggregate.connection.error!,/估值缺失/);
  assert.deepEqual(snapshotValues([aggregate.asset,{...asset,id:'row-2',mode:'manual',value:25}],{error:null},Date.parse(now)),{
    total:25,missingValues:1,partial:true,
  });
});

test('one unknown saved account keeps the Aster aggregate unknown without losing known account values',()=>{
  const now='2026-10-23T04:00:00Z';
  const saved=[{...legacy()[0],updatedAt:now,lastSync:now},{...legacy()[0],id:'second',name:'二号',value:null,updatedAt:now,lastSync:now}];
  const accounts=readAsterAccounts(JSON.stringify(saved),['aster','aster:second'],asset,connection);
  const result=aggregateAster(accounts,asset,now);
  assert.deepEqual(accounts.map(account=>account.value),[150,null]);
  assert.equal(result.asset.value,null);
  assert.equal(result.asset.quantity,null);
  assert.match(result.asset.status,/估值缺失/);
  assert.match(result.asset.error!,/二号：估值缺失/);
  assert.equal(snapshotValues([result.asset],{error:null},Date.parse(now)).partial,true);
});

test('genuine zero balances remain complete for legacy and multiple Aster accounts',()=>{
  const now='2026-10-23T04:00:00Z',zero={...asset,quantity:0,value:0,updatedAt:now};
  const accounts=readAsterAccounts(undefined,['aster'],zero,{...connection,lastSync:now});
  const second={...accounts[0],id:'second',name:'二号'};
  for(const included of [accounts,[...accounts,second]]){
    const result=aggregateAster(included,zero,now);
    assert.equal(result.asset.value,0);
    assert.equal(result.asset.error,undefined);
    assert.equal(result.connection.error,null);
    assert.deepEqual(snapshotValues([result.asset],{error:null},Date.parse(now)),{total:0,missingValues:0,partial:false});
  }
});

test('saved missing and malformed valuations stay unknown instead of becoming a successful zero',()=>{
  for(const value of [null,undefined,'0',false]){
    const saved=[{...legacy()[0],value}];
    const accounts=readAsterAccounts(JSON.stringify(saved),['aster'],asset,connection);
    assert.equal(accounts[0].value,null);
    const result=aggregateAster(accounts,asset,asset.updatedAt);
    assert.equal(result.asset.value,null);
    assert.match(result.asset.error!,/估值缺失/);
  }
});

test('a successful zero balance resolves an unknown aggregate while independent failures remain visible',()=>{
  const now='2026-10-23T04:00:00Z';
  const account={...legacy()[0],value:null,updatedAt:now,lastSync:now};
  const failed=aggregateAster([{...account,error:'同步失败'}],asset,now);
  assert.equal(failed.asset.value,null);
  assert.match(failed.asset.error!,/同步失败.*估值缺失/);
  const recovered=aggregateAster([{...account,value:0,error:null}],asset,now);
  assert.equal(recovered.asset.value,0);
  assert.equal(recovered.asset.error,undefined);
  assert.equal(recovered.connection.error,null);
  assert.equal(snapshotValues([recovered.asset],{error:null},Date.parse(now)).partial,false);
});
test('refresh results merge by identity: removed accounts stay removed and replaced credentials keep the newer state',()=>{
  const base={...legacy()[0],details:[]};
  const current:AsterAccount[]=[{...base,id:'kept',name:'保留',value:1},{...base,id:'rekeyed',name:'换钥',value:2,walletAddress:'0xnew'},{...base,id:'added',name:'新增',value:3}];
  const merged=mergeAsterRefresh(current,[
    {id:'kept',credential:'c-kept',patch:{value:10,error:null}},
    {id:'rekeyed',credential:'c-old',patch:{value:20,walletAddress:'0xold'}},
    {id:'removed',credential:'c-removed',patch:{value:30}},
  ],new Map([[asterKey('kept'),'c-kept'],[asterKey('rekeyed'),'c-new'],[asterKey('added'),'c-added']]));
  assert.deepEqual(merged.map(a=>[a.id,a.value,a.walletAddress]),[['kept',10,base.walletAddress],['rekeyed',2,'0xnew'],['added',3,base.walletAddress]]);
  const failed=mergeAsterRefresh([current[0]],[{id:'kept',credential:'c-kept',patch:{error:'同步失败'}}],new Map([[asterKey('kept'),'c-kept']]));
  assert.deepEqual([failed[0].value,failed[0].error],[1,'同步失败'],'A failed read records its error and keeps the last value');
});
