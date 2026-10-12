import { seedLedger, readSource } from './seed';
import { db } from './sqlite';
export { db } from './sqlite';
import { seal, unseal } from './vault';
import { quotes, syncBybit, syncAster, syncBinance, validateAsterWallet } from './exchanges';
import { syncOkx } from './okx';
import { syncVariational } from './variational';
import { isVariationalProject } from './source-ledger';
import { editValue, type Credentials, type WithdrawalInput, type AsterAccountInput } from './validation';
import { asterKey, readAsterAccounts, aggregateAster } from './aster-accounts';
import { embeddedWithdrawals } from './withdrawals';
import { yuanQuote } from './fx';
import { mapConcurrent, settleIndependent } from './concurrency';
import type { Asset, Ledger, Connection, Period, Withdrawal, FxStatus, AsterAccount } from './types';

export const chinaDate=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
export async function initialize(owner:string){
  const ready=await db().prepare('SELECT value FROM settings WHERE owner = ? AND key = ?').bind(owner,'initialized').first();
  if(ready)return;
  const source=readSource(), seed=seedLedger(source);
  await db().batch([
    ...seed.assets.map(a=>db().prepare('INSERT OR IGNORE INTO assets(owner,id,data) VALUES(?,?,?)').bind(owner,a.id,JSON.stringify(a))),
    db().prepare('INSERT OR IGNORE INTO settings(owner,key,value) VALUES(?,?,?)').bind(owner,'fx',String(seed.fx)),
    db().prepare('INSERT OR IGNORE INTO settings(owner,key,value) VALUES(?,?,?)').bind(owner,'source-ledger',JSON.stringify(source)),
    db().prepare('INSERT OR IGNORE INTO settings(owner,key,value) VALUES(?,?,?)').bind(owner,'initialized','1'),
  ]);
}
async function readSnapshotHistory(owner:string):Promise<Period[]>{
  // Daily keys are ISO dates. Imported archives have archive-* keys, so they
  // cannot share the indexed date window without displacing recent snapshots.
  const fields="json_remove(s.data, '$.assets') AS data, COALESCE(json_extract(s.data, '$.withdrawn'), (SELECT TOTAL(json_extract(a.value, '$.value')) FROM json_each(s.data, '$.assets') a WHERE trim(json_extract(a.value, '$.project')) = '出金')) AS withdrawn";
  const rows=await Promise.all([
    db().prepare(`SELECT ${fields} FROM snapshots s WHERE owner = ? AND date < 'a' ORDER BY date DESC LIMIT 730`).bind(owner).all<{data:string;withdrawn:number}>(),
    db().prepare(`SELECT ${fields} FROM snapshots s WHERE owner = ? AND date >= 'a' ORDER BY json_extract(s.data, '$.date') DESC LIMIT 730`).bind(owner).all<{data:string;withdrawn:number}>(),
  ]);
  return rows.flatMap(result=>result.results.map(row=>({...JSON.parse(row.data),withdrawn:row.withdrawn} as Period))).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,730);
}
async function readLedger(owner:string,includeHistory:boolean):Promise<Ledger>{
  await initialize(owner);
  const [rows, settings, connectionRows, snapshotRows]=await Promise.all([
    db().prepare('SELECT data FROM assets WHERE owner = ?').bind(owner).all<{data:string}>(),
    db().prepare('SELECT key,value FROM settings WHERE owner = ?').bind(owner).all<{key:string,value:string}>(),
    db().prepare('SELECT exchange FROM connections WHERE owner = ?').bind(owner).all<{exchange:string}>(),
    includeHistory ? readSnapshotHistory(owner) : Promise.resolve([]),
  ]);
  const source=settings.results.find(s=>s.key==='source-ledger');
  const ledger=seedLedger(source?JSON.parse(source.value):readSource(),includeHistory);
  ledger.assets=rows.results.map(r=>JSON.parse(r.data) as Asset).sort((a,b)=>Number(a.id.slice(4))-Number(b.id.slice(4)));
  ledger.fx=Number(settings.results.find(s=>s.key==='fx')?.value??ledger.fx);
  ledger.fxStatus=JSON.parse(settings.results.find(s=>s.key==='fx-status')?.value??'null')??ledger.fxStatus;
  for(const name of ['bybit','aster','binance','okx','variational'] as const){
    const meta=settings.results.find(s=>s.key===name+'-status');
    ledger.connections[name]={...ledger.connections[name],...(meta?JSON.parse(meta.value):{}),configured:connectionRows.results.some(r=>r.exchange===name)} as Connection;
  }
  const savedAccounts=settings.results.find(s=>s.key==='aster-accounts')?.value;
  const asterAsset=ledger.assets.find(a=>a.mode==='aster');
  ledger.asterAccounts=readAsterAccounts(savedAccounts,connectionRows.results.map(r=>r.exchange),asterAsset,ledger.connections.aster);
  if(savedAccounts!==undefined&&asterAsset)ledger.connections.aster=aggregateAster(ledger.asterAccounts,asterAsset,new Date().toISOString()).connection;
  ledger.history.push(...snapshotRows);
  ledger.withdrawals=JSON.parse(settings.results.find(s=>s.key==='withdrawals')?.value??'[]');
  return ledger;
}
export const getLedger=(owner:string)=>readLedger(owner,true);
export const getCurrentLedger=(owner:string)=>readLedger(owner,false);
async function saveAsset(owner:string,a:Asset){await db().prepare('UPDATE assets SET data = ? WHERE owner = ? AND id = ?').bind(JSON.stringify(a),owner,a.id).run();}
async function setting(owner:string,key:string,value:unknown){await db().prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value').bind(owner,key,typeof value==='string'?value:JSON.stringify(value)).run();}
async function snapshot(owner:string){
  const ledger=await getCurrentLedger(owner);
  const total=ledger.assets.reduce((s,a)=>s+(a.value??0),0), date=chinaDate();
  const partial=!!ledger.fxStatus.error||ledger.assets.some(a=>a.mode!=='manual'&&(!!a.error||Date.now()-new Date(a.updatedAt).getTime()>900000));
  const data={id:'daily-'+date,date,total,fx:ledger.fx,fxStatus:ledger.fxStatus,cny:total*ledger.fx,future:false,difference:0,partial,withdrawn:embeddedWithdrawals(ledger.assets),updatedAt:new Date().toISOString(),assets:ledger.assets};
  await db().prepare('INSERT INTO snapshots(owner,date,data) VALUES(?,?,?) ON CONFLICT(owner,date) DO UPDATE SET data=excluded.data').bind(owner,date,JSON.stringify(data)).run();
}
export async function lock(owner:string){
  const now=Date.now();
  const result=await db().prepare('INSERT INTO sync_locks(owner,expires) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET expires=excluded.expires WHERE sync_locks.expires < ?').bind(owner,now+120000,now).run();
  if(!result.meta.changes)throw new Error('资产正在更新，请稍后重试');
}
export async function unlock(owner:string){await db().prepare('DELETE FROM sync_locks WHERE owner = ?').bind(owner).run();}
export async function editAsset(owner:string,input:{id:string,quantity:number,price:number|null}){
  await lock(owner);
  try{
    const ledger=await getCurrentLedger(owner), asset=ledger.assets.find(a=>a.id===input.id);
    if(!asset)throw new Error('未找到该资产');
    if(asset.mode==='bybit'||asset.mode==='aster'||asset.mode==='binance'||asset.mode==='okx'||asset.mode==='variational')throw new Error('交易所资产由只读接口维护');
    const price=asset.mode==='market'?asset.price:input.price;
    const status=asset.mode==='manual'?'手动估值':asset.status;
    const next={...asset,quantity:input.quantity,price,value:editValue(input.quantity,price),status};
    if(asset.mode==='manual')next.updatedAt=new Date().toISOString();
    await saveAsset(owner,next);await snapshot(owner);
    return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function editFx(owner:string,fx:number){
  await lock(owner);try{await saveFx(owner,fx,{source:'manual',fetchedAt:new Date().toISOString(),rateDate:null,error:null});await snapshot(owner);return getLedger(owner);}finally{await unlock(owner);}
}
async function saveFx(owner:string,rate:number,status:FxStatus){
  await db().batch(Object.entries({'fx':String(rate),'fx-status':JSON.stringify(status)}).map(([key,value])=>db().prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value').bind(owner,key,value)));
}
export async function saveWithdrawal(owner:string,input:WithdrawalInput,editing=false){
  await lock(owner);
  try{
    const ledger=await getCurrentLedger(owner);
    if(input.date<ledger.baselineDate)throw new Error('新增出金日期不能早于原表基准日 '+ledger.baselineDate+'，原表出金已单独计入');
    if(input.date>chinaDate())throw new Error('不能登记尚未发生的出金');
    const existing=ledger.withdrawals.find(row=>row.id===input.id);
    if(editing&&!existing)throw new Error('未找到出金记录，请刷新页面');
    if(!editing&&existing){
      if(existing.date===input.date&&existing.amount===input.amount&&existing.note===input.note)return getLedger(owner);
      throw new Error('出金记录编号重复，请刷新页面');
    }
    if(!editing&&ledger.withdrawals.length>=2000)throw new Error('出金记录已达到 2000 条上限');
    const now=new Date().toISOString();
    const record:Withdrawal={...input,createdAt:existing?.createdAt??now,updatedAt:now};
    await setting(owner,'withdrawals',editing?ledger.withdrawals.map(row=>row.id===input.id?record:row):[...ledger.withdrawals,record]);
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function deleteWithdrawal(owner:string,id:string){
  await lock(owner);
  try{
    const ledger=await getCurrentLedger(owner);
    await setting(owner,'withdrawals',ledger.withdrawals.filter(row=>row.id!==id));
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function connect(owner:string,input:Credentials){
  if(input.exchange==='aster')return connectAsterAccount(owner,{...input,id:'default',name:'默认账号'},'legacy');
  await lock(owner);
  try{
    const ledger=await getCurrentLedger(owner);
    const matches=ledger.assets.filter(a=>a.mode===input.exchange||(a.mode==='manual'&&(input.exchange==='variational'?isVariationalProject(a.project):['binance','okx'].includes(input.exchange)&&a.project.trim().toLowerCase()===input.exchange)));
    if(matches.length>1)throw new Error('已有多条交易所资产，请先合并重复记录');
    let asset=matches[0];
    if(!asset){
      if(input.exchange!=='binance'&&input.exchange!=='okx'&&input.exchange!=='variational')throw new Error('未找到交易所资产');
      const nextId=Math.max(0,...ledger.assets.map(a=>Number(a.id.slice(4))))+1;
      if(ledger.assets.length>=1000||!Number.isSafeInteger(nextId)||nextId>999999)throw new Error('资产条目已达到上限');
      asset={id:'row-'+nextId,project:input.exchange==='variational'?'var':input.exchange,kind:'资产',quantity:0,price:1,value:0,cell:'E'+nextId,mode:input.exchange,updatedAt:'',status:''};
    }
    const encrypted=await seal(input,owner+':'+input.exchange);
    const result=input.exchange==='variational'?await syncVariational(input):input.exchange==='okx'?await syncOkx(input):await (async()=>{
      const prices=await quotes();
      return input.exchange==='binance'?syncBinance(input,prices):syncBybit(input,prices);
    })();
    const now=new Date().toISOString();
    const updatedAt='updatedAt' in result?result.updatedAt:now;
    const next={...asset,mode:input.exchange,quantity:result.total,price:1,value:result.total,status:input.exchange==='variational'?'只读同步 · 获取时间':'只读同步',updatedAt,error:undefined,details:result.details};
    const status={configured:true,lastSync:now,error:null,scope:ledger.connections[input.exchange].scope,...(input.exchange==='variational'?{}:{label:input.apiKey.slice(-4)})};
    // Persist a verified connection and its balance together; failed verification changes neither.
    await db().batch([
      db().prepare('INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner,exchange) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at').bind(owner,input.exchange,encrypted,now),
      db().prepare('INSERT INTO assets(owner,id,data) VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET data=excluded.data').bind(owner,asset.id,JSON.stringify(next)),
      db().prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value').bind(owner,input.exchange+'-status',JSON.stringify(status)),
    ]);
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function disconnect(owner:string,exchange:'bybit'|'aster'|'binance'|'okx'|'variational'){
  if(exchange==='aster')return deleteAsterAccount(owner,'default','disconnect');
  await lock(owner);try{
    const ledger=await getCurrentLedger(owner),asset=ledger.assets.find(a=>a.mode===exchange);
    await db().batch([
      db().prepare('DELETE FROM connections WHERE owner = ? AND exchange = ?').bind(owner,exchange),
      db().prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value').bind(owner,exchange+'-status',JSON.stringify({configured:false,lastSync:ledger.connections[exchange].lastSync,error:null,scope:ledger.connections[exchange].scope})),
      ...(asset?[db().prepare('UPDATE assets SET data = ? WHERE owner = ? AND id = ?').bind(JSON.stringify({...asset,status:'已断开 · 保留旧值',error:undefined}),owner,asset.id)]:[]),
    ]);
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
async function saveAsterAccounts(owner:string,accounts:AsterAccount[],asset:Asset,credential?:{key:string;encrypted?:string}){
  const now=new Date().toISOString(),aggregate=aggregateAster(accounts,asset,now);
  const statements=[
    ...Object.entries({'aster-accounts':accounts,'aster-status':aggregate.connection}).map(([key,value])=>db().prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value').bind(owner,key,JSON.stringify(value))),
    db().prepare('UPDATE assets SET data = ? WHERE owner = ? AND id = ?').bind(JSON.stringify(aggregate.asset),owner,asset.id),
  ];
  if(credential)statements.push(credential.encrypted===undefined
    ?db().prepare('DELETE FROM connections WHERE owner = ? AND exchange = ?').bind(owner,credential.key)
    :db().prepare('INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner,exchange) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at').bind(owner,credential.key,credential.encrypted,now));
  await db().batch(statements);
}
export async function connectAsterAccount(owner:string,input:AsterAccountInput,editing:boolean|'legacy'){
  await lock(owner);
  try{
    const ledger=await getCurrentLedger(owner),accounts=ledger.asterAccounts,existing=accounts.find(a=>a.id===input.id);
    if(editing===true&&!existing)throw new Error('未找到该 Aster 账号，请刷新页面');
    if(editing===false&&existing)throw new Error('账号已存在，请使用更新连接');
    if(!existing&&accounts.length>=10)throw new Error('最多添加 10 个 Aster 账号');
    if(accounts.some(a=>a.id!==input.id&&a.name===input.name))throw new Error('账号名称已存在');
    const credentials={exchange:'aster' as const,walletAddress:input.walletAddress,privateKey:input.privateKey,includeSpot:input.includeSpot};
    const wallet=validateAsterWallet(credentials),key=asterKey(input.id);
    if(accounts.some(a=>a.id!==input.id&&a.walletAddress?.toLowerCase()===wallet.address.toLowerCase()))throw new Error('该 API 钱包已存在，请更新或移除已有账号');
    const stored=await db().prepare("SELECT exchange,encrypted FROM connections WHERE owner = ? AND (exchange = 'aster' OR exchange LIKE 'aster:%')").bind(owner).all<{exchange:string;encrypted:string}>();
    for(const row of stored.results){
      if(row.exchange===key)continue;
      let other;
      try{other=await unseal(row.encrypted,owner+':'+row.exchange);}catch{throw new Error('已有 Aster 连接无法读取，请先更新或移除异常账号');}
      if(other.walletAddress?.toLowerCase()===wallet.address.toLowerCase())throw new Error('该 API 钱包已连接，请更新已有账号');
      const account=accounts.find(a=>asterKey(a.id)===row.exchange);
      if(account)account.walletAddress=other.walletAddress;
    }
    const encrypted=await seal(credentials,owner+':'+key);
    const result=await syncAster(credentials,await quotes()),now=new Date().toISOString();
    const account:AsterAccount={id:input.id,name:input.name,includeSpot:input.includeSpot,walletAddress:wallet.address,configured:true,lastSync:now,updatedAt:now,error:null,scope:input.includeSpot?'API Pro · 合约 + 现货':'API Pro · 合约净权益',label:wallet.address.slice(-4),value:result.total,details:result.details};
    await saveAsterAccounts(owner,existing?accounts.map(a=>a.id===input.id?account:a):[...accounts,account],ledger.assets.find(a=>a.mode==='aster')!,{key,encrypted});
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function deleteAsterAccount(owner:string,id:string,action:'disconnect'|'remove'){
  await lock(owner);
  try{
    const ledger=await getCurrentLedger(owner),existing=ledger.asterAccounts.find(a=>a.id===id);
    if(!existing)throw new Error('未找到该 Aster 账号，请刷新页面');
    if(action==='disconnect'&&!existing.walletAddress){
      const row=await db().prepare('SELECT encrypted FROM connections WHERE owner = ? AND exchange = ?').bind(owner,asterKey(id)).first<{encrypted:string}>();
      if(row){try{existing.walletAddress=(await unseal(row.encrypted,owner+':'+asterKey(id))).walletAddress;}catch{/* A broken connection can still be disconnected. */}}
    }
    const accounts=action==='remove'?ledger.asterAccounts.filter(a=>a.id!==id):ledger.asterAccounts.map(a=>a.id===id?{...a,configured:false,error:null}:a);
    await saveAsterAccounts(owner,accounts,ledger.assets.find(a=>a.mode==='aster')!,{key:asterKey(id)});
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
export async function refresh(owner:string){
  await lock(owner);
  try{
    const ledger=await getCurrentLedger(owner);
    const last=await db().prepare('SELECT value FROM settings WHERE owner = ? AND key = ?').bind(owner,'last-attempt').first<{value:string}>();
    if(last&&Date.now()-Number(last.value)<30000)return getLedger(owner);
    await setting(owner,'last-attempt',String(Date.now()));
    const stored=await db().prepare('SELECT exchange,encrypted FROM connections WHERE owner = ?').bind(owner).all<{exchange:string,encrypted:string}>();
    await settleIndependent([async()=>{
      const [marketResult]=await Promise.allSettled([quotes()]);
      const prices=marketResult.status==='fulfilled'?marketResult.value:undefined;
      const marketError=marketResult.status==='rejected'?(marketResult.reason instanceof Error?marketResult.reason.message:'无法获取行情'):undefined;
      const virtual=ledger.assets.find(a=>a.mode==='market')!;
      if(prices){await saveAsset(owner,{...virtual,price:prices.VIRTUAL.price,value:(virtual.quantity??0)*prices.VIRTUAL.price,updatedAt:prices.VIRTUAL.at,status:prices.VIRTUAL.source+' · 实时单价',error:undefined});}
      else await saveAsset(owner,{...virtual,status:'行情失败 · 保留旧值',error:marketError});
      const walletSync=async(exchange:'bybit'|'binance')=>{
        const row=stored.results.find(row=>row.exchange===exchange);
        if(!row)return;
        const asset=ledger.assets.find(a=>a.mode===exchange);
        try{
          if(!asset)throw new Error('未找到交易所资产，请更新连接');
          if(!prices)throw new Error(marketError);
          const c=await unseal(row.encrypted,owner+':'+row.exchange);
          const result=await (exchange==='binance'?syncBinance(c,prices):syncBybit(c,prices));
          const now=new Date().toISOString();
          await saveAsset(owner,{...asset,quantity:result.total,price:1,value:result.total,details:result.details,updatedAt:now,status:'只读同步',error:undefined});
          await setting(owner,exchange+'-status',{...ledger.connections[exchange],lastSync:now,error:null});
        }catch(e){
          const error=e instanceof Error?e.message:'同步暂时失败';
          if(asset)await saveAsset(owner,{...asset,status:'同步失败 · 保留旧值',error});
          await setting(owner,exchange+'-status',{...ledger.connections[exchange],error});
        }
      };
      const asterSync=async()=>{if(ledger.asterAccounts.length){
        const accounts=await mapConcurrent(ledger.asterAccounts,3,async account=>{
          const row=stored.results.find(r=>r.exchange===asterKey(account.id));
          if(!row)return account;
          try{
            if(!prices)throw new Error(marketError);
            const credentials=await unseal(row.encrypted,owner+':'+row.exchange);
            const result=await syncAster(credentials,prices),now=new Date().toISOString();
            return {...account,walletAddress:credentials.walletAddress,value:result.total,details:result.details,lastSync:now,updatedAt:now,error:null};
          }catch(e){return {...account,error:e instanceof Error?e.message:'同步暂时失败'};}
        });
        await saveAsterAccounts(owner,accounts,ledger.assets.find(a=>a.mode==='aster')!);
      }};
      const completed=await Promise.allSettled([walletSync('bybit'),walletSync('binance'),asterSync()]);
      for(const result of completed)if(result.status==='rejected')throw result.reason;
    },async()=>{
      const row=stored.results.find(row=>row.exchange==='okx');
      if(!row)return;
      const asset=ledger.assets.find(a=>a.mode==='okx');
      try{
        if(!asset)throw new Error('未找到交易所资产，请更新连接');
        const credentials=await unseal(row.encrypted,owner+':okx');
        // OKX supplies USD valuations directly, independently of public coin quotes.
        const result=await syncOkx(credentials),now=new Date().toISOString();
        await saveAsset(owner,{...asset,quantity:result.total,price:1,value:result.total,details:result.details,updatedAt:result.updatedAt,status:'只读同步',error:undefined});
        await setting(owner,'okx-status',{...ledger.connections.okx,lastSync:now,error:null});
      }catch(e){
        const error=e instanceof Error?e.message:'同步暂时失败';
        if(asset)await saveAsset(owner,{...asset,status:'同步失败 · 保留旧值',error});
        await setting(owner,'okx-status',{...ledger.connections.okx,error});
      }
    },async()=>{
      const row=stored.results.find(row=>row.exchange==='variational');
      if(!row)return;
      const asset=ledger.assets.find(a=>a.mode==='variational');
      try{
        if(!asset)throw new Error('未找到 Var 资产，请更新连接');
        const credentials=await unseal(row.encrypted,owner+':variational');
        const result=await syncVariational(credentials),now=new Date().toISOString();
        await saveAsset(owner,{...asset,quantity:result.total,price:1,value:result.total,details:result.details,updatedAt:result.updatedAt,status:'只读同步 · 获取时间',error:undefined});
        await setting(owner,'variational-status',{...ledger.connections.variational,lastSync:now,error:null});
      }catch(e){
        // Neither transport nor decryption exceptions may expose session material.
        const error=e instanceof Error&&e.message.startsWith('Var ')?e.message:'Var 同步失败，请更新会话或稍后重试；已保留上次数据';
        if(asset)await saveAsset(owner,{...asset,status:'同步失败 · 保留旧值',error});
        await setting(owner,'variational-status',{...ledger.connections.variational,error});
      }
    },async()=>{
      const [fxResult]=await Promise.allSettled([yuanQuote()]);
      if(fxResult.status==='fulfilled')await saveFx(owner,fxResult.value.rate,fxResult.value.status);
      else await setting(owner,'fx-status',{...ledger.fxStatus,error:'人民币汇率更新失败，保留上次汇率'});
    }]);
    await snapshot(owner);return getLedger(owner);
  }finally{await unlock(owner);}
}
