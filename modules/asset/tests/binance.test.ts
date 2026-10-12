import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {binanceGet, syncBinance, type BinanceCredential, type Quote} from '../lib/exchanges.ts';

const credential: BinanceCredential = {apiKey:'binance-fixture-key',apiSecret:'binance-fixture-secret'};
const permissionsPath = '/sapi/v1/account/apiRestrictions';
const walletsPath = '/sapi/v1/asset/wallet/balance';
const coreWriteFields = ['enableWithdrawals','enableInternalTransfer','enableMargin','enableFutures','permitsUniversalTransfer','enableVanillaOptions','enableSpotAndMarginTrading'];
const newWriteFields = ['enableFixApiTrade','enablePortfolioMarginTrading'];
function permissions(): Record<string, unknown> {
  return {enableReading:true,...Object.fromEntries([...coreWriteFields,...newWriteFields].map(field=>[field,false])),enableFixReadOnly:true};
}
function prices(): Record<string, Quote> {return {USDT:{price:0.999,at:new Date().toISOString(),source:'fixture / USD'}};}
function wallet(balance='0',walletName='Spot',activate=true) {return {activate,balance,walletName};}
function mock(handler:(url:URL,init:RequestInit)=>unknown):typeof fetch {
  return (async(url:RequestInfo|URL,init:RequestInit={})=>Response.json(handler(new URL(String(url)),init))) as typeof fetch;
}
function response(wallets:unknown,info:unknown=permissions()):typeof fetch {
  return mock(url=>url.pathname===permissionsPath?info:wallets);
}

test('Binance signs exactly the transmitted GET query, uses the official host, and reads permissions first',async()=>{
  const calls:string[]=[];
  const result=await syncBinance(credential,prices(),mock((url,init)=>{
    calls.push(url.pathname);
    assert.equal(url.protocol,'https:');assert.equal(url.host,'api.binance.com');
    assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.body,undefined);
    assert.deepEqual(init.headers,{'X-MBX-APIKEY':credential.apiKey});
    assert.equal(url.href.includes(credential.apiSecret),false);assert.equal(url.href.includes(credential.apiKey),false);
    const query=url.search.slice(1,url.search.lastIndexOf('&signature='));
    assert.equal(url.searchParams.get('signature'),createHmac('sha256',credential.apiSecret).update(query).digest('hex'));
    assert.ok(Math.abs(Number(url.searchParams.get('timestamp'))-Date.now())<5000);
    assert.equal(url.searchParams.get('recvWindow'),'10000');
    if(url.pathname===permissionsPath){assert.deepEqual([...url.searchParams.keys()],['timestamp','recvWindow','signature']);return permissions();}
    assert.equal(url.pathname,walletsPath);assert.deepEqual([...url.searchParams.keys()],['quoteAsset','timestamp','recvWindow','signature']);
    assert.equal(url.searchParams.get('quoteAsset'),'USDT');
    return [wallet('100','Spot'),wallet('10.5','Funding'),wallet('-5','USDⓈ-M Futures'),wallet('0','Margin'),wallet('0','Options',false)];
  }));
  assert.deepEqual(calls,[permissionsPath,walletsPath]);
  assert.equal(result.total,100*0.999+10.5*0.999-5*0.999);
  assert.deepEqual(result.details.map(row=>row.quantity),[100,10.5,-5,0]);
  assert.ok(result.details.every(row=>row.coin==='USDT'&&row.price===0.999&&row.account.endsWith('（折合 USDT）')));
  assert.equal(result.details[2].value,-4.995);
});

test('Binance wallet aggregates are counted once and do not add per-asset balances or P&L',async()=>{
  const result=await syncBinance(credential,prices(),response([{...wallet('100'),assetBalances:[{asset:'USDT',free:'900',locked:'100'}],unrealizedProfit:'50'},wallet('25','Funding')]));
  assert.equal(result.total,124.875);assert.equal(result.details.length,2);
});

test('Binance accepts real zero and negative totals while skipping inactive zero wallets',async()=>{
  const zero=await syncBinance(credential,prices(),response([wallet('-0.000'),wallet('0','Options',false)]));
  assert.equal(zero.total,0);assert.equal(zero.details.length,1);assert.equal(zero.details[0].quantity,0);assert.equal(zero.details[0].value,0);
  const inactive=await syncBinance(credential,prices(),response([wallet('0','Options',false)]));
  assert.deepEqual(inactive,{total:0,details:[]});
  const negative=await syncBinance(credential,prices(),response([wallet('-10')]));
  assert.equal(negative.total,-9.99);
});

test('Binance rejects every enabled, missing or malformed core write permission before fetching assets',async()=>{
  for(const field of coreWriteFields){
    for(const value of [true,undefined,null,0,1,'false','true']){
      const info=permissions();if(value===undefined)delete info[field];else info[field]=value;
      const calls:string[]=[];
      await assert.rejects(syncBinance(credential,prices(),mock(url=>{calls.push(url.pathname);return info;})),/无法确认只读权限/);
      assert.deepEqual(calls,[permissionsPath],field+'='+String(value));
    }
  }
  for(const value of [false,undefined,null,1,'true']){
    const info=permissions();if(value===undefined)delete info.enableReading;else info.enableReading=value;
    let calls=0;
    await assert.rejects(syncBinance(credential,prices(),mock(()=>{calls++;return info;})),/只读权限/);
    assert.equal(calls,1);
  }
});

test('Binance explicitly supports older responses without new FIX/portfolio fields, but checks all present fields',async()=>{
  const legacy=permissions();for(const field of [...newWriteFields,'enableFixReadOnly'])delete legacy[field];
  assert.equal((await syncBinance(credential,prices(),response([wallet('1')],legacy))).total,0.999);
  for(const field of newWriteFields){
    for(const value of [true,null,1,'false']){
      let calls=0;
      await assert.rejects(syncBinance(credential,prices(),mock(()=>{calls++;return {...permissions(),[field]:value};})),/只读权限/);
      assert.equal(calls,1);
    }
  }
  for(const value of [null,1,'false'])await assert.rejects(syncBinance(credential,prices(),response([wallet()],{...permissions(),enableFixReadOnly:value})),/只读权限/);
  for(const value of [true,false])assert.equal((await syncBinance(credential,prices(),response([wallet()],{...permissions(),enableFixReadOnly:value}))).total,0);
});

test('Binance validates permissions again on each sync after a key permission changes',async()=>{
  let allowed=true,assetReads=0;
  const fetcher=mock(url=>{
    if(url.pathname===permissionsPath)return {...permissions(),enableWithdrawals:!allowed};
    assetReads++;return [wallet('1')];
  });
  await syncBinance(credential,prices(),fetcher);allowed=false;
  await assert.rejects(syncBinance(credential,prices(),fetcher),/只读权限/);assert.equal(assetReads,1);
});

test('Binance refuses missing, empty or malformed wallet and permission structures',async()=>{
  for(const invalid of [null,false,'secret fixture',[],{}, {data:[wallet()]},[null],[[]],[{}],[{...wallet(),walletName:''}],[{...wallet(),walletName:'  '}],[{...wallet(),walletName:1}],[{...wallet(),activate:'true'}],[{balance:'0',walletName:'Spot'}]]){
    await assert.rejects(syncBinance(credential,prices(),response(invalid)),/数据不完整/);
  }
  for(const invalid of [null,false,1,'secret fixture',[],{}]){
    let calls=0;await assert.rejects(syncBinance(credential,prices(),mock(()=>{calls++;return invalid;})),/数据不完整|只读权限/);assert.equal(calls,1);
  }
});

test('Binance rejects duplicate wallets and inconsistent inactive balances',async()=>{
  for(const names of [['Spot','Spot'],[' Spot ','spot']])await assert.rejects(syncBinance(credential,prices(),response(names.map(name=>wallet('1',name)))),/钱包重复/);
  for(const balance of ['1','-1'])await assert.rejects(syncBinance(credential,prices(),response([wallet(balance,'Options',false)])),/未激活钱包返回非零/);
});

test('Binance rejects invalid numeric values, underflow and overflowing dollar totals',async()=>{
  for(const balance of ['',null,undefined,false,0,1,[],{},' ','NaN','Infinity','-Infinity','0x10','1e3',' 1','1 ','1,000','0.'+'0'.repeat(400)+'1','9'.repeat(400)]){
    await assert.rejects(syncBinance(credential,prices(),response([{...wallet(),balance}])),/余额不是有效数值/);
  }
  const huge='1'+'0'.repeat(308);
  await assert.rejects(syncBinance(credential,{USDT:{...prices().USDT,price:2}},response([wallet(huge)])),/美元估值不是有效数值/);
  await assert.rejects(syncBinance(credential,{USDT:{...prices().USDT,price:1}},response([wallet(huge),wallet(huge,'Funding')])),/美元估值不是有效数值/);
  await assert.rejects(syncBinance(credential,{USDT:{...prices().USDT,price:Number.MIN_VALUE}},response([wallet('0.01')])),/美元估值不是有效数值/);
});

test('Binance requires a finite positive and fresh USDT/USD quote before reading credentials remotely',async()=>{
  const invalidQuotes:Record<string,Quote>[]=[{},...[-1,0,NaN,Infinity].map(price=>({USDT:{...prices().USDT,price}})),...['invalid',new Date(Date.now()-900001).toISOString(),new Date(Date.now()+120000).toISOString()].map(at=>({USDT:{...prices().USDT,at}})),{USDT:{...prices().USDT,price:'1'} as unknown as Quote}];
  for(const quotes of invalidQuotes){let calls=0;await assert.rejects(syncBinance(credential,quotes,mock(()=>{calls++;return permissions();})),/行情无效或已过期/);assert.equal(calls,0);}
});

test('Binance allowlist rejects orders, transfers, arbitrary hosts and query injection before any fetch',async()=>{
  let calls=0;const never=mock(()=>{calls++;return {};});
  for(const path of ['/api/v3/order','/sapi/v1/asset/transfer','/sapi/v1/capital/withdraw/apply','/api/v3/account','constructor','https://evil.example/'+permissionsPath,permissionsPath+'?redirect=https://evil.example',walletsPath+'/../transfer',walletsPath+'#anything'])await assert.rejects(binanceGet(credential,path,never),/只读账户接口/);
  assert.equal(calls,0);
  for(const invalid of [{apiKey:'',apiSecret:'fixture'},{apiKey:'fixture',apiSecret:''},{apiKey:'fixture',apiSecret:'   '}])await assert.rejects(binanceGet(invalid,permissionsPath,never),/不能为空/);
  assert.equal(calls,0);
});

test('Binance errors expose only fixed messages and numeric codes, never response bodies or secrets',async()=>{
  const sensitive=credential.apiKey+' '+credential.apiSecret+' https://api.binance.com/signed?signature=private';
  for(const code of [-2015,123,'-2015',sensitive,{},null]){
    await assert.rejects(binanceGet(credential,permissionsPath,mock(()=>({code,msg:sensitive}))),error=>{
      assert.ok(error instanceof Error);assert.equal(error.message.includes(sensitive),false);assert.equal(error.message.includes(credential.apiKey),false);assert.equal(error.message.includes(credential.apiSecret),false);
      assert.match(error.message,typeof code==='number'?new RegExp('（'+code+'）'):/未知代码/);return true;
    });
  }
  for(const fetcher of [
    (async()=>{throw new Error(sensitive);}) as typeof fetch,
    (async()=>new Response(sensitive,{status:200})) as typeof fetch,
    (async()=>new Response(sensitive,{status:401})) as typeof fetch,
  ])await assert.rejects(binanceGet(credential,permissionsPath,fetcher),error=>error instanceof Error&&/Binance 读取失败/.test(error.message)&&!error.message.includes(credential.apiKey)&&!error.message.includes(credential.apiSecret)&&!error.message.includes('signature='));
});

test('Binance refuses redirects without forwarding authenticated headers to another host',async()=>{
  let calls=0;
  const redirect=(async(_url:unknown,init:RequestInit)=>{calls++;assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{location:'https://evil.example'}});}) as typeof fetch;
  await assert.rejects(binanceGet(credential,permissionsPath,redirect),/HTTP 302/);assert.equal(calls,1);
});
