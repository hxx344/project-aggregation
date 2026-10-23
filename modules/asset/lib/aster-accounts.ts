import type { Asset, AsterAccount, Connection } from './types.ts';
import { sumKnownValues } from './asset-values.ts';

export const asterKey=(id:string)=>id==='default'?'aster':'aster:'+id;
export function readAsterAccounts(saved:string|undefined, keys:string[], asset:Asset|undefined, connection:Connection):AsterAccount[]{
  const accounts:AsterAccount[]=saved!==undefined?JSON.parse(saved):asset&&(keys.includes('aster')||connection.lastSync)?[{
    ...connection,id:'default',name:'默认账号',value:asset.value,details:asset.details??[],updatedAt:asset.updatedAt,includeSpot:connection.scope.includes('现货'),
  }]:[];
  return accounts.map(account=>({...account,value:Number.isFinite(account.value)?account.value:null,configured:keys.includes(asterKey(account.id))}));
}
export function aggregateAster(accounts:AsterAccount[],asset:Asset,now:string):{asset:Asset;connection:Connection}{
  const values=sumKnownValues(accounts),value=values.partial?null:values.total;
  const errors=accounts.filter(a=>a.error||!a.configured||!Number.isFinite(a.value)).map(a=>a.name+'：'+[
    a.error||(!a.configured?'已断开，保留旧值':''),!Number.isFinite(a.value)?'估值缺失':'',
  ].filter(Boolean).join('；'));
  // The aggregate cannot be newer than its oldest included account.
  const updatedAt=accounts.reduce((oldest,a)=>Date.parse(a.updatedAt)<Date.parse(oldest)?a.updatedAt:oldest,now);
  const lastSync=accounts.length&&accounts.every(a=>a.lastSync)?accounts.map(a=>a.lastSync!).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]:null;
  return {
    asset:{...asset,quantity:value,price:1,value,updatedAt,status:values.partial?'部分账号估值缺失':errors.length?'部分账号未更新 · 保留旧值':accounts.length?'只读同步 · '+accounts.length+' 个账号':'未添加账号',error:errors.join('；')||undefined,details:accounts.flatMap(a=>a.details.map(b=>({...b,account:a.name+' / '+b.account})))},
    connection:{configured:accounts.some(a=>a.configured),lastSync,error:errors.join('；')||null,scope:'API Pro · '+accounts.length+' 个账号',...(accounts.length===1?{label:accounts[0].label}:{})},
  };
}
