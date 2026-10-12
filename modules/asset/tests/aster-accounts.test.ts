import test from 'node:test';
import assert from 'node:assert/strict';
import {asterKey,readAsterAccounts,aggregateAster} from '../lib/aster-accounts.ts';
import {asterAccountSchema,asterAccountDeleteSchema} from '../lib/validation.ts';
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
