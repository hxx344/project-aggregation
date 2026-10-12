import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Wallet, verifyTypedData} from 'ethers';
import {syncBybit,syncAster,bybitGet,asterGet,finite,quotes,readJson,validateAsterWallet,type AsterCredential} from '../lib/exchanges.ts';
import {editValue,editSchema,connectionSchema} from '../lib/validation.ts';
const at=new Date().toISOString();
const prices={USDT:{price:0.999,at,source:'fixture'},USDC:{price:1,at,source:'fixture'}};
const testWallet=Wallet.createRandom();
const aster={walletAddress:testWallet.address,privateKey:testWallet.privateKey,includeSpot:false};
const c={apiKey:'fixture-key',apiSecret:'fixture-secret',region:'global' as const};
function mock(handler:(url:URL,init:RequestInit)=>unknown):typeof fetch{
 return (async(url:RequestInfo|URL,init:RequestInit={})=>Response.json(handler(new URL(String(url)),init))) as typeof fetch;
}
test('Bybit uses USD totalEquity plus funding; signing uses exactly the transmitted query',async()=>{
 const result=await syncBybit(c,prices,mock((u,init)=>{
  assert.equal(init.method,'GET');assert.equal(u.host,'api.bybit.com');
  const h=init.headers as Record<string,string>;
  const signed=h['X-BAPI-TIMESTAMP']+c.apiKey+'10000'+u.search.slice(1);
  assert.equal(h['X-BAPI-SIGN'],createHmac('sha256',c.apiSecret).update(signed).digest('hex'));
  if(u.pathname.endsWith('query-api'))return {retCode:0,result:{readOnly:1}};
  if(u.pathname.endsWith('wallet-balance'))return {retCode:0,result:{list:[{accountType:'UNIFIED',totalEquity:'1000',totalWalletBalance:'1200',totalMarginBalance:'1100',coin:[{coin:'USDT',equity:'1001',usdValue:'1000',walletBalance:'1200',spotBorrow:'200'}]}]}};
  return {retCode:0,result:{balance:[{coin:'USDT',walletBalance:'20',transferBalance:'5'}]}};
 }));
 assert.equal(result.total,1019.98);assert.equal(result.details.length,2);
});
test('Bybit rejects a write-enabled key before reading assets',async()=>{
 let calls=0;await assert.rejects(syncBybit(c,prices,mock(()=>{calls++;return {retCode:0,result:{readOnly:0}};})),/不是只读/);assert.equal(calls,1);
});
test('Aster API Pro signs the exact EIP-712 GET query; marginBalance includes P&L exactly once; spot includes locked balances',async()=>{
 const result=await syncAster({...aster,includeSpot:true},prices,mock((u,init)=>{
  assert.equal(init.method,'GET');const sig=u.searchParams.get('signature');u.searchParams.delete('signature');
  assert.equal(u.searchParams.get('signer'),aster.walletAddress);
  assert.ok(Math.abs(Number(u.searchParams.get('nonce'))-Date.now()*1000)<1_000_000);
  assert.deepEqual([...u.searchParams.keys()],['nonce','signer']);
  const recovered=verifyTypedData({name:'AsterSignTransaction',version:'1',chainId:1666,verifyingContract:'0x0000000000000000000000000000000000000000'},{Message:[{name:'msg',type:'string'}]},{msg:u.search.slice(1)},sig!);
  assert.equal(recovered,aster.walletAddress);
  assert.equal(JSON.stringify(init).includes(aster.privateKey),false);
  assert.equal(u.href.includes(aster.privateKey),false);
  assert.equal(init.headers,undefined);
  if(u.pathname==='/fapi/v3/accountWithJoinMargin'){assert.equal(u.host,'fapi.asterdex.com');return {assets:[{asset:'USDT',walletBalance:'100',unrealizedProfit:'10',marginBalance:'110'},{asset:'USDC',walletBalance:'5',unrealizedProfit:'-10',marginBalance:'-5'}],positions:[{notional:'9000'}]};}
  assert.equal(u.host,'sapi.asterdex.com');assert.equal(u.pathname,'/api/v3/account');return {balances:[{asset:'USDC',free:'20',locked:'5'}]};
 }));
 assert.equal(result.total,129.89);assert.equal(result.details.length,3);
});
test('Aster rejects missing account data instead of fabricating zero',async()=>{
 await assert.rejects(syncAster({...aster,includeSpot:false},prices,mock(()=>({}))),/不完整/);
 await assert.rejects(syncAster({...aster,includeSpot:false},prices,mock(()=>({assets:[{asset:'USDT',marginBalance:''}]}))),/有效数值/);
});
test('Empty but valid Aster account totals zero',async()=>assert.equal((await syncAster({...aster,includeSpot:false},prices,mock(()=>({assets:[]})))).total,0));
test('Read-only path allowlists reject order and transfer routes before sending credentials',async()=>{
 const never=mock(()=>{throw new Error('must not fetch');});
 await assert.rejects(bybitGet(c,'/v5/order/create','',never),/只读/);
 await assert.rejects(asterGet({...aster,includeSpot:false},'/fapi/v1/order' as '/fapi/v3/accountWithJoinMargin',never),/只读/);
});
test('Invalid numbers, unexpected mutation properties and invalid wallet inputs are rejected',()=>{
 for(const value of ['',null,undefined,NaN,Infinity,true])assert.throws(()=>finite(value,'test'));
 assert.throws(()=>editSchema.parse({id:'row-2',quantity:-1,price:1}));
 assert.throws(()=>editSchema.parse({id:'row-2',quantity:1,price:1,mode:'manual'}));
 assert.throws(()=>connectionSchema.parse({exchange:'aster',address:'0x123'}));
 assert.throws(()=>editValue(1,null));assert.equal(editValue(0,null),0);assert.equal(editValue(100,0.625),62.5);
});
test('Stale or missing quotes are errors',async()=>{
 await assert.rejects(quotes(mock(()=>({'virtual-protocol':{usd:1,last_updated_at:1}}))),/过期/);
 await assert.rejects(quotes(mock(()=>({}))),/有效数值/);
});
test('Redirects are not followed by authenticated requests',async()=>{
 const redirect=(async(_u:unknown,init:RequestInit)=>{assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{location:'https://example.net'}});}) as typeof fetch;
 await assert.rejects(readJson('https://api.bybit.com',{},redirect),/HTTP 302/);
});
test('Coinbase backup quote converts coins per USD to USD per coin',async()=>{
 const result=await quotes(mock(u=>u.host==='api.coingecko.com'?{}:{data:{currency:'USD',rates:{VIRTUAL:'2',USDT:'1.01',USDC:'1'}}}));
 assert.equal(result.VIRTUAL.price,0.5);assert.equal(result.USDT.price,1/1.01);assert.match(result.VIRTUAL.source,/Coinbase/);
});


test('Aster validates wallet ownership locally and hides crypto errors',async()=>{
 const never=mock(()=>{throw new Error('must not fetch');});
 await assert.rejects(syncAster({...aster,walletAddress:'0x'+'0'.repeat(40)},prices,never),/不匹配/);
 for(const privateKey of ['0x'+'0'.repeat(64),'0x'+'f'.repeat(64)]){
  assert.throws(()=>validateAsterWallet({...aster,privateKey}),error=>error instanceof Error && /私钥无效/.test(error.message) && !error.message.includes(privateKey));
 }
 await assert.rejects(syncAster({...c,includeSpot:false} as unknown as AsterCredential,prices,never),/连接需要更新/);
 const parsed=connectionSchema.parse({exchange:'aster',...aster,privateKey:aster.privateKey.slice(2)});
 assert.equal(parsed.exchange,'aster');
 assert.throws(()=>connectionSchema.parse({exchange:'aster',...c,includeSpot:false}));
 assert.throws(()=>connectionSchema.parse({exchange:'aster',...aster,url:'https://untrusted.example'}));
});

test('Aster concurrent account reads always use distinct microsecond nonces',async()=>{
 const nonces:string[]=[];
 const fetcher=mock(u=>{nonces.push(u.searchParams.get('nonce')!);return {assets:[],balances:[]};});
 await Promise.all(Array.from({length:12},()=>syncAster({...aster,includeSpot:true},prices,fetcher)));
 assert.equal(nonces.length,24);assert.equal(new Set(nonces).size,24);
});

test('Aster refuses trading, withdrawal, legacy and arbitrary paths before signing',async()=>{
 const never=mock(()=>{throw new Error('must not fetch');});
 for(const path of ['/fapi/v3/order','/api/v3/asset/wallet/transfer','/api/v3/aster/user-withdraw','/fapi/v4/account','/api/v1/account','constructor','https://example.com']){
  await assert.rejects(asterGet(aster,path as '/fapi/v3/accountWithJoinMargin',never),/只读余额/);
 }
});
