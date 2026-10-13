'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Wallet, ChartNoAxesCombined, History, Cable, RefreshCw, Pencil, ShieldCheck, ChevronRight, Eye, ArrowUpRight } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import type { Ledger, Asset, Period } from '@/lib/types';
import { ImportLedgerDialog } from './import-ledger-dialog';
import { AssetTrend } from './asset-trend';
import { WithdrawalsPanel } from './withdrawals-panel';
import { AsterAccountsPanel } from './aster-accounts-panel';
import { VariationalDiagnostics } from './variational-diagnostics';
import type { VariationalDiagnosticComparisonReport } from '@/lib/variational-diagnostic-types';
import { assetMeasures, assetDisplayRows, embeddedWithdrawals, chinaDay, periodMeasures } from '@/lib/withdrawals';
import { createHubBridge } from '@/lib/hub-bridge';
import { requestJson, createRequestSlot } from '@/lib/client-request';
import { nextLedgerExpiry } from '@/lib/client-freshness';
import { startRefreshLoop } from '@/lib/refresh-loop';

const money=(n:number,d=2)=>n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const stamp=(s:string|null)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'尚未同步';
const viewNames={overview:'资产总览',history:'历史记录',withdrawals:'出金记录',connections:'交易所连接'};
type View=keyof typeof viewNames;
const exchangeNames={bybit:'Bybit',binance:'Binance',okx:'OKX',gate:'Gate',aster:'Aster',variational:'Var · Variational'};
const connectionDescriptions={bybit:'统一账户净权益与资金账户余额；包含未实现盈亏，不重复累加保证金。',binance:'国际站钱包资产估值，读取各钱包折合 USDT 的余额并换算为美元；范围以 Binance 接口返回为准。',okx:'当前账户总资产的美元估值，查看交易、资金和理财账户分项；范围以 OKX 接口返回为准，不自动汇总子账户。',gate:'国际站账户总资产的美元估值，提供各账户估值分项；范围以 Gate 接口返回为准，不自动汇总子账户，接口数据最多缓存 1 分钟。',variational:'Omni 账户的 USDC 净权益按 USDC/USD 换算为美元；包含未实现盈亏，不重复累加保证金或持仓名义价值。'};
type Exchange=keyof typeof exchangeNames;
function isExchangeMode(mode:Asset['mode']):mode is Exchange{return mode==='bybit'||mode==='binance'||mode==='okx'||mode==='gate'||mode==='aster'||mode==='variational';}
async function api(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<Ledger>{
 const timeoutMs=path==='/api/sync'?75_000:['/api/connections','/api/aster-accounts'].includes(path)?60_000:30_000;
 return requestJson<Ledger>(path,{method,headers:method==='GET'?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal,timeoutMs});
}
function badge(a:Asset,now:number){
 if(a.mode!=='manual'&&a.status.includes('同步')&&!a.error&&now-new Date(a.updatedAt).getTime()>300000)return '数据已过期 · 保留旧值';
 if(a.mode==='market'&&!a.error&&now-new Date(a.updatedAt).getTime()>900000)return '行情已过期 · 保留旧值';
 return a.status;
}
export default function Dashboard({initial}:{initial:Ledger}){
 const [ledger,setLedger]=useState(initial),[filter,setFilter]=useState('all'),[view,setView]=useState<View>('overview');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(()=>Date.now());
 const [editing,setEditing]=useState<Asset|null>(null),[quantity,setQuantity]=useState(''),[price,setPrice]=useState('');
 const [fxOpen,setFxOpen]=useState(false),[fx,setFx]=useState(String(initial.fx)),[formError,setFormError]=useState('');
 const [connectTo,setConnectTo]=useState<Exclude<Exchange,'aster'>|null>(null),[key,setKey]=useState(''),[secret,setSecret]=useState(''),[passphrase,setPassphrase]=useState(''),[vrToken,setVrToken]=useState(''),[region,setRegion]=useState('global');
 const [diagnosticReport,setDiagnosticReport]=useState<VariationalDiagnosticComparisonReport|null>(null),[diagnosticError,setDiagnosticError]=useState(''),[diagnosticRunning,setDiagnosticRunning]=useState(false);
 const [detail,setDetail]=useState<Asset|null>(null),[period,setPeriod]=useState<Period|null>(null),[periodRows,setPeriodRows]=useState<Asset[]>([]);
 const busyRef=useRef(false),importOpenRef=useRef(false);
 const bridgeRef=useRef<ReturnType<typeof createHubBridge>|null>(null),historyRequestRef=useRef<AbortController|null>(null);
 const diagnosticRequestRef=useRef<AbortController|null>(null);
 const requests=useRef(createRequestSlot());
 const ledgerRef=useRef(initial),activeRef=useRef(false),mountedRef=useRef(false);
 const [importOpen,setImportOpen]=useState(false);
 function toggleImport(open:boolean){importOpenRef.current=open;setImportOpen(open);}
  const refresh=useCallback(async(manual=false)=>{
  if(busyRef.current||importOpenRef.current||(!manual&&!activeRef.current))return;busyRef.current=true;setBusy(true);
  const controller=requests.current.start(!manual);if(!controller){busyRef.current=false;setBusy(false);return;}
  try{
   const data=await api('/api/sync','POST',{},controller.signal);
   if(controller.signal.aborted||!mountedRef.current)return;
   const previous=ledgerRef.current;
   const changed=manual||JSON.stringify([previous.assets,previous.fx,previous.fxStatus,previous.withdrawals,previous.connections,previous.asterAccounts])!==JSON.stringify([data.assets,data.fx,data.fxStatus,data.withdrawals,data.connections,data.asterAccounts]);
   ledgerRef.current=data;setLedger(data);setError('');if(changed)bridgeRef.current?.changed();if(manual)toast.success('已完成刷新，更新状态见资产明细');
  }
  catch(e){if(!controller.signal.aborted&&mountedRef.current)setError(e instanceof Error?e.message:'更新失败');}
  finally{if(requests.current.finish(controller)){busyRef.current=false;if(mountedRef.current){setBusy(false);setNow(Date.now());}}}
 },[]);
 useEffect(()=>{
  mountedRef.current=true;
  let foreground=false;
  const onActivity=(active:boolean)=>{
   activeRef.current=active;
   if(!activeRef.current&&requests.current.cancel(true)){busyRef.current=false;setBusy(false);}
   setNow(Date.now());
  };
  const bridge=createHubBridge({onActivity:active=>{const regained=active&&!foreground;foreground=active;loop?.synchronize(regained?new Event('focus'):undefined);},onNavigate:({projectId,query})=>{if(projectId==='asset'&&Object.keys(query).length===0){setView('overview');location.hash='overview';window.scrollTo({top:0});}}});bridgeRef.current=bridge;
  const loop=startRefreshLoop({page:document,view:window,enabled:()=>bridge.readActive&&navigator.onLine,onActivity,refresh:()=>void refresh()});
  const slot=requests.current;
  return()=>{mountedRef.current=false;loop?.stop();bridge.dispose();bridgeRef.current=null;slot.cancel();diagnosticRequestRef.current=null;historyRequestRef.current?.abort();busyRef.current=false;};
 },[refresh]);
 useEffect(()=>{
  if(!bridgeRef.current?.readActive)return;
  const time=Date.now(),next=nextLedgerExpiry(ledger,time);
  if(next===null)return;
  const timer=setTimeout(()=>setNow(Date.now()),Math.min(next-time,2_147_483_647));
  return()=>clearTimeout(timer);
 },[ledger,now]);
 useEffect(()=>{
  const read=()=>{const v=location.hash.slice(1);if(v in viewNames)setView(v as View);};read();window.addEventListener('hashchange',read);return()=>window.removeEventListener('hashchange',read);
 },[]);
 useEffect(()=>{
  const context=(document as Document & {modelContext?:{registerTool:(tool:unknown,options:unknown)=>Promise<void>|void}}).modelContext;
  if(!context?.registerTool)return;
  const lifecycle=new AbortController();
  Promise.resolve(context.registerTool({name:'read_asset_ledger',description:'读取当前资产估值、单价、来源及更新时间，不进行同步或修改。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute:(input:unknown)=>{if(!input||typeof input!=='object'||Object.keys(input).length)throw new Error('无需参数');return {assets:ledger.assets,fx:ledger.fx,baselineDate:ledger.baselineDate};}},{signal:lifecycle.signal})).catch(()=>{});
  return()=>lifecycle.abort();
 },[ledger]);
 const navigate=useCallback((v:View)=>{setView(v);if(window.location.hash!=='#'+v)window.history.pushState(null,'','#'+v);window.scrollTo({top:0});},[]);
 const openHistory=useCallback(()=>navigate('history'),[navigate]);
 async function mutate(path:string,method:string,body:unknown,onSuccess:()=>void){
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setFormError('');
  const controller=requests.current.start();if(!controller){busyRef.current=false;setBusy(false);return;}
  try{const data=await api(path,method,body,controller.signal);if(controller.signal.aborted||!mountedRef.current)return;ledgerRef.current=data;setLedger(data);setError('');bridgeRef.current?.changed();onSuccess();toast.success('已保存');}
  catch(e){if(!controller.signal.aborted&&mountedRef.current)setFormError(e instanceof Error?e.message:'保存失败，输入已保留');}
  finally{if(requests.current.finish(controller)){busyRef.current=false;if(mountedRef.current){setBusy(false);setNow(Date.now());}}}
 }
 function edit(a:Asset){const original=ledger.assets.find(row=>row.id===a.id);if(!original){navigate('withdrawals');return;}a=original;setEditing(a);setQuantity(String(a.quantity??0));setPrice(a.price===null?'':String(a.price));setFormError('');}
 function clearDiagnostic(){
  const controller=diagnosticRequestRef.current;diagnosticRequestRef.current=null;
  if(controller){controller.abort();if(requests.current.finish(controller)){busyRef.current=false;if(mountedRef.current)setBusy(false);}}
  setDiagnosticReport(null);setDiagnosticError('');setDiagnosticRunning(false);
 }
 async function testVariationalAccess(){
  if(busyRef.current||connectTo!=='variational'||vrToken.trim().length<5)return;
  busyRef.current=true;setBusy(true);
  const controller=requests.current.start();if(!controller){busyRef.current=false;setBusy(false);return;}
  diagnosticRequestRef.current=controller;setDiagnosticRunning(true);setDiagnosticReport(null);setDiagnosticError('');setFormError('');
  try{
   const report=await requestJson<VariationalDiagnosticComparisonReport>('/api/connections/variational-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vrToken:vrToken.trim()}),signal:controller.signal,timeoutMs:30_000});
   if(controller.signal.aborted||!mountedRef.current||diagnosticRequestRef.current!==controller)return;
   setDiagnosticReport(report);
  }
  catch(e){if(!controller.signal.aborted&&mountedRef.current&&diagnosticRequestRef.current===controller)setDiagnosticError(e instanceof Error&&e.name==='TimeoutError'?'测试超时，请稍后重试':e instanceof Error?e.message:'测试失败，请稍后重试');}
  finally{
   if(diagnosticRequestRef.current===controller){diagnosticRequestRef.current=null;if(mountedRef.current)setDiagnosticRunning(false);}
   if(requests.current.finish(controller)){busyRef.current=false;if(mountedRef.current)setBusy(false);}
  }
 }
 function closeConnection(){clearDiagnostic();setConnectTo(null);setKey('');setSecret('');setPassphrase('');setVrToken('');}
 function connection(exchange:Exchange){clearDiagnostic();if(exchange==='aster'){navigate('connections');return;}setConnectTo(exchange);setKey('');setSecret('');setPassphrase('');setVrToken('');setFormError('');}
 async function openPeriod(p:Period){
  historyRequestRef.current?.abort();const controller=new AbortController();historyRequestRef.current=controller;
  setPeriod(p);setPeriodRows([]);setFormError('');
  try{const data=await requestJson<{rows:Asset[]}>('/api/history?id='+encodeURIComponent(p.id),{signal:controller.signal});if(!controller.signal.aborted&&mountedRef.current)setPeriodRows(data.rows);}
  catch(e){if(!controller.signal.aborted&&mountedRef.current)setFormError(e instanceof Error?e.message:'无法读取历史明细');}
 }
 const total=ledger.assets.reduce((s,a)=>s+(a.value??0),0);
 const exchangeTotal=ledger.assets.reduce((s,a)=>s+(isExchangeMode(a.mode)?a.value??0:0),0);
 const pointsTotal=ledger.assets.filter(a=>a.kind.includes('积分')).reduce((s,a)=>s+(a.value??0),0);
 const today=chinaDay(new Date(now));
 const rows=assetDisplayRows(ledger.assets,ledger.withdrawals,today).filter(a=>filter==='all'||(filter==='manual'?a.mode==='manual':a.mode!=='manual')).sort((a,b)=>(b.value??0)-(a.value??0));
 const measures=assetMeasures(total,embeddedWithdrawals(ledger.assets),ledger.withdrawals,today);
 const fxStale=!!ledger.fxStatus.error||!ledger.fxStatus.fetchedAt||now-Date.parse(ledger.fxStatus.fetchedAt)>300000;
 const fxSource=ledger.fxStatus.source==='manual'?'手动备用':ledger.fxStatus.source==='saved'?'原表 / 已保存值':ledger.fxStatus.source==='Frankfurter'?'Frankfurter / ECB（日度参考）':'Coinbase';
 const pending=Object.values(ledger.connections).filter(c=>!c.configured).length;
 const failures=ledger.assets.filter(a=>a.error);
 const nav=[{id:'overview' as View,label:'资产总览',Icon:ChartNoAxesCombined},{id:'history' as View,label:'历史记录',Icon:History},{id:'withdrawals' as View,label:'出金记录',Icon:ArrowUpRight},{id:'connections' as View,label:'交易所连接',Icon:Cable}];
 const renderTable=(assets:Asset[],editable=true)=><Table><TableHeader><TableRow><TableHead>项目 / 资产</TableHead><TableHead>类型</TableHead><TableHead className="numeric">数量</TableHead><TableHead className="numeric">单价 / USD</TableHead><TableHead className="numeric">估值 / USD</TableHead>{editable&&<><TableHead>数据来源 / 更新时间</TableHead><TableHead>操作</TableHead></>}</TableRow></TableHeader><TableBody>{assets.map(a=><TableRow key={a.id}><TableCell><strong className="asset-name">{a.project}</strong>{editable&&a.project.trim()==='出金'&&measures.recorded>0&&<small className="ticker">{a.id==='recorded-withdrawals'?'新增出金记录':ledger.assets.find(row=>row.id===a.id)?.value!==a.value?'含新增出金记录':''}</small>}{a.project==='virtual'&&<small className="ticker">VIRTUAL</small>}</TableCell><TableCell><span className="kind">{a.kind}</span></TableCell><TableCell className="numeric">{editable&&isExchangeMode(a.mode)?a.mode==='binance'?'钱包资产估值':a.mode==='okx'||a.mode==='gate'?'账户资产估值':'账户权益':a.quantity===null?'—':money(a.quantity,a.quantity%1?4:0)}</TableCell><TableCell className="numeric">{editable&&isExchangeMode(a.mode)?'—':a.price===null?'—':money(a.price,a.price<1?6:2)}</TableCell><TableCell className="numeric asset-value">{a.value===null?'—':money(a.value)}</TableCell>{editable&&<><TableCell><span title={a.error} className={'status '+(a.mode==='manual'?'':a.error||badge(a,now).includes('旧值')||badge(a,now).includes('待')?'amber':'live')}>{badge(a,now)}</span><small className="ticker">{stamp(a.updatedAt)}</small></TableCell><TableCell>{isExchangeMode(a.mode)?<button className="icon-button" aria-label={'查看 '+a.project+' 资产'} onClick={()=>a.details?setDetail(a):connection(a.mode as Exchange)}><Eye size={16}/></button>:<button className="icon-button" aria-label={a.id==='recorded-withdrawals'?'管理出金记录':'编辑 '+a.project+' '+a.kind} onClick={()=>edit(a)}><Pencil size={15}/></button>}</TableCell></>}</TableRow>)}</TableBody></Table>;
 return <div className="ledger-shell">
 <a className="skip-link" href="#ledger-content">跳到页面内容</a>
 <header className="topbar">
   <div className="brand"><Wallet aria-hidden="true"/><div>资产账本<small>ASSET LEDGER</small></div></div>
   <div className="topbar-actions">
     <span className="workspace-date">{new Date(now).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric'})}</span>
     <span className="privacy"><ShieldCheck size={16} aria-hidden="true"/>独立密码保护</span>
   </div>
 </header>
 <nav className="workspace-nav" aria-label="账本功能"><div>{nav.map(({id,label,Icon})=><button type="button" key={id} aria-current={view===id?'page':undefined} onClick={()=>navigate(id)}><Icon size={17} aria-hidden="true"/><span>{label}</span></button>)}</div></nav>
 <main className="workspace" id="ledger-content" tabIndex={-1}><div className="page"><div className="page-heading"><div><h1>{viewNames[view]}</h1><p>{view==='overview'?'实时估值与手动资产，统一记录。':view==='history'?'保留原表记录；每天保存最近一次更新。':view==='withdrawals'?'登记出金，观察剔除提款影响后的资产变化。':'通过读取接口获取账户资产，连接凭据仅加密保存在服务端。'}</p></div><button className="button primary" disabled={busy} onClick={()=>void refresh(true)}><RefreshCw className={busy?'loading-spin':''} size={16}/>{busy?'正在更新':'刷新资产'}</button></div>
 {ledger.dataKind==='example'&&<div className="notice import-notice"><div><strong>当前为示例数据，尚未导入你的原表</strong><p>这里的资产和金额是演示内容。导入原表后才会显示你的真实持仓和历史。</p></div><button className="button primary" disabled={busy} onClick={()=>toggleImport(true)}>导入原表数据</button></div>}
 {error&&<div className="notice" role="alert">{error}。当前显示上次已保存的数据。</div>}
 {ledger.fxStatus.error&&<div className="notice" role="status">{ledger.fxStatus.error}，人民币折算暂用 1 USD = {money(ledger.fx,4)} CNY。</div>}
 {view==='overview'&&<><section className="summary"><div><div className="metric-label">表内总额 <span>USD · 含累计出金</span></div><div className="total-number">$ {money(measures.adjusted)}</div><p className="muted">折合人民币 ¥ {money(measures.adjusted*ledger.fx)} <button className="text-button" aria-label="人民币汇率详情与备用设置" onClick={()=>{setFx(String(ledger.fx));setFormError('');setFxOpen(true);}}><Pencil size={12}/></button></p><div className="fx-summary"><span className={'status '+(fxStale?'amber':'live')}>1 USD = {money(ledger.fx,4)} CNY · {ledger.fxStatus.error?'更新失败 · 保留旧值':fxStale?'待更新':ledger.fxStatus.source==='manual'?'临时手动':'自动更新'}</span><small>{fxSource}{ledger.fxStatus.rateDate?' · 报价日期 '+ledger.fxStatus.rateDate:' · 获取时间 '+stamp(ledger.fxStatus.fetchedAt)}</small></div></div>
 <div className="secondary-metric">
  <div className="metric-label">交易所资产</div>
  <strong>$ {money(exchangeTotal)}</strong>
  <span className="muted">折合人民币 ¥ {money(exchangeTotal*ledger.fx)}</span>
  <span className={'status '+(pending?'amber':'live')}>{pending?pending+' 个账户待连接':'账户已连接'}</span>
 </div>
 <div className="secondary-metric">
  <div className="metric-label">积分预估价值</div>
  <strong>$ {money(pointsTotal)}</strong>
  <span className="muted">折合人民币 ¥ {money(pointsTotal*ledger.fx)}</span>
  <span className="muted">沿用表格估值，可手动编辑</span>
 </div></section>
 {failures.length>0&&<div className="notice" role="status">{failures.map(a=>a.project+'：'+a.error).join('；')}</div>}
 <section className="withdrawal-summary" aria-label="出金调整口径"><div><span>实际持有资产 / USD</span><strong>$ {money(measures.held)}</strong><p>表内总额减去累计出金</p></div><div className="adjusted-metric"><span>剔除出金影响 / USD</span><strong>$ {money(measures.adjusted)}</strong><p>实际持有资产 + 累计出金</p></div><div><span>累计出金 / USD</span><strong>$ {money(measures.withdrawn)}</strong><button className="text-button" onClick={()=>navigate('withdrawals')}>管理出金记录 <ArrowUpRight size={14}/></button></div></section>
 <div className="chart-grid"><AssetTrend ledger={ledger} today={today} onHistory={openHistory}/>
 <section className="panel sync-panel"><div className="panel-title"><h2>数据连接</h2><ShieldCheck size={18}/></div>{(['bybit','binance','okx','gate','aster','variational'] as const).map(name=><button className="connection-row" key={name} onClick={()=>connection(name)}><div className={'exchange-mark '+name}>{exchangeNames[name][0]}</div><div><strong>{exchangeNames[name]}</strong><small>{ledger.connections[name].configured?'已连接 · '+stamp(ledger.connections[name].lastSync):name==='variational'?'待连接 Omni 会话':name==='gate'?'待连接资产读取接口':'待连接只读接口'}</small></div><ChevronRight size={17}/></button>)}<div className="connection-row"><div className="exchange-mark virtual">V</div><div><strong>Virtual</strong><small>实时单价 · 数量手动</small></div></div><div className="sync-note">页面打开时每 60 秒刷新<br/>USD/CNY 随刷新自动更新<br/>{fxSource}</div></section></div>
 <section className="panel holdings"><div className="holdings-heading"><h2>资产明细 <span>{rows.length}</span></h2><Tabs value={filter} onValueChange={setFilter}><TabsList><TabsTrigger value="all">全部资产</TabsTrigger><TabsTrigger value="auto">自动更新</TabsTrigger><TabsTrigger value="manual">手动维护</TabsTrigger></TabsList></Tabs></div>{renderTable(rows)}</section></>}
 {view==='history'&&<><div className="notice">原表未来预填和导入前示例不计入曲线。同日多份记录在此保留；曲线优先采用日快照，其次采用最后一份原表记录。此处“原始表内总额”保留历史原值；总览表内总额与当前明细已加入新增出金。</div><section className="panel holdings"><Table><TableHeader><TableRow><TableHead>日期（北京时间）</TableHead><TableHead>来源</TableHead><TableHead className="numeric">原始表内总额 / USD</TableHead><TableHead className="numeric">实际持有 / USD</TableHead><TableHead className="numeric">累计出金 / USD</TableHead><TableHead className="numeric">剔除出金影响 / USD</TableHead><TableHead className="numeric">汇率</TableHead><TableHead className="numeric">原总额 / CNY</TableHead><TableHead>核对 / 明细</TableHead></TableRow></TableHeader><TableBody>{[...ledger.history].sort((a,b)=>b.date.localeCompare(a.date)).map(p=>{const values=periodMeasures(p,ledger),included=!p.future&&!p.archived;return <TableRow key={p.id}><TableCell>{p.date}</TableCell><TableCell><span className={'status '+(p.future||p.partial?'amber':'')}>{p.archived?'导入前示例记录':p.future?'原表预填':p.id.startsWith('daily-')?(p.partial?'当日快照 · 含旧值':'当日最后更新'):'原表 '+p.id}</span></TableCell><TableCell className="numeric">{money(p.total)}</TableCell><TableCell className="numeric">{included?money(values.held):'—'}</TableCell><TableCell className="numeric">{included?money(values.withdrawn):'—'}</TableCell><TableCell className="numeric">{included?money(values.adjusted):'—'}</TableCell><TableCell className="numeric" title={p.fxStatus?(p.fxStatus.source==='Frankfurter'?'Frankfurter / ECB · 报价日 '+p.fxStatus.rateDate:p.fxStatus.source+' · '+stamp(p.fxStatus.fetchedAt)):'原记录汇率'}>{p.fx}{p.fxStatus?.error&&<small className="ticker">沿用旧汇率</small>}</TableCell><TableCell className="numeric">{money(p.cny)}</TableCell><TableCell><button className="text-button" onClick={()=>void openPeriod(p)}>{p.difference?'合计差异 $ '+money(p.difference):'查看明细'}</button></TableCell></TableRow>;})}</TableBody></Table></section><p className="help section-note">日快照在刷新或编辑时保存；页面关闭期间不补造记录。入金未剔除，资产变化不等于投资收益。</p></>}
 {view==='withdrawals'&&<WithdrawalsPanel ledger={ledger} today={today} busy={busy} error={formError} mutate={mutate} clearError={()=>setFormError('')}/>}
 {view==='connections'&&<div className="connections-grid">{(['bybit','binance','okx','gate','variational'] as const).map(name=><section className="panel connection-card" key={name}><div className="connection-card-title"><div className={'exchange-mark '+name}>{exchangeNames[name][0]}</div><h2>{exchangeNames[name]}</h2><span className={'status '+(ledger.connections[name].configured?'live':'amber')}>{ledger.connections[name].configured?'已连接':'未连接'}</span></div><p className="help">{connectionDescriptions[name]}</p><p className="help section-note">最近成功同步：{stamp(ledger.connections[name].lastSync)}</p>{ledger.connections[name].error&&<p className="error-text">{ledger.connections[name].error}</p>}<div className="form-actions"><button className="button primary" onClick={()=>connection(name)}>{ledger.connections[name].configured?'更新连接':'连接账户'}</button></div></section>)}<AsterAccountsPanel accounts={ledger.asterAccounts} busy={busy} error={formError} clearError={()=>setFormError('')} mutate={mutate}/></div>}
 <footer className="page-footer">{ledger.dataKind==='example'?'示例账本 · 尚未导入原表':'源自《资产统计.xlsx》'} · 起始持仓 {ledger.baselineDate} · 自 {ledger.startedAt} 开始更新</footer></div></main>
 <Dialog open={!!editing} onOpenChange={v=>!v&&setEditing(null)}><DialogContent><DialogHeader><DialogTitle>编辑 {editing?.project}</DialogTitle><DialogDescription>{editing?.kind} · {editing?.project.trim()==='出金'?'仅编辑原表出金；新增出金由出金记录自动叠加，请在出金记录中修改。':editing?.mode==='market'?'单价按行情更新，持仓数量手动维护。':'修改后重新计算估值，并保存当日快照。'}</DialogDescription></DialogHeader><form className="form-grid" onSubmit={e=>{e.preventDefault();if(editing)void mutate('/api/ledger','PATCH',{id:editing.id,quantity:Number(quantity),price:price===''?null:Number(price)},()=>setEditing(null));}}><label>数量<input type="number" min="0" step="any" required value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><label>单价 / USD<input type="number" min="0" step="any" value={price} disabled={editing?.mode==='market'} onChange={e=>setPrice(e.target.value)}/></label><p className="help">估值：{price===''?'待填写单价':'$ '+money(Number(quantity)*Number(price))}</p>{formError&&<p className="error-text" role="alert">{formError}</p>}<div className="form-actions"><button type="button" className="button" onClick={()=>setEditing(null)}>取消</button><button className="button primary" disabled={busy}>保存修改</button></div></form></DialogContent></Dialog>
 <Dialog open={fxOpen} onOpenChange={setFxOpen}><DialogContent><DialogHeader><DialogTitle>人民币换算汇率</DialogTitle><DialogDescription>每 60 秒随资产自动更新。可临时设置备用值，下一次自动获取成功后会覆盖；历史快照保留当时汇率。</DialogDescription></DialogHeader><p className="help">当前来源：{fxSource}<br/>{ledger.fxStatus.rateDate?'报价日期：'+ledger.fxStatus.rateDate:'获取时间：'+stamp(ledger.fxStatus.fetchedAt)}<br/>来源未提供逐笔报价时间时，展示获取时间。</p><form className="form-grid" onSubmit={e=>{e.preventDefault();void mutate('/api/ledger','PATCH',{fx:Number(fx)},()=>setFxOpen(false));}}><label>1 USD 折合 CNY<input type="number" min="0.001" step="any" required value={fx} onChange={e=>setFx(e.target.value)}/></label>{formError&&<p className="error-text" role="alert">{formError}</p>}<button className="button primary" disabled={busy}>临时使用此汇率</button></form></DialogContent></Dialog>
 <Dialog open={!!connectTo} onOpenChange={v=>{if(!v)closeConnection();}}><DialogContent><DialogHeader><DialogTitle>连接 {connectTo?exchangeNames[connectTo]:''}</DialogTitle><DialogDescription>{connectTo==='variational'?'通过 Omni 网页会话读取账户净权益，成功后加密保存令牌。':connectTo==='gate'?'验证账户余额可读，成功后加密保存；无法自动验证密钥只读权限。':'验证只读权限与余额，成功后加密保存。'}</DialogDescription></DialogHeader>
  <form className="form-grid" onSubmit={e=>{e.preventDefault();if(!connectTo)return;const credentials=connectTo==='variational'?{exchange:connectTo,vrToken:vrToken.trim()}:{exchange:connectTo,apiKey:key.trim(),apiSecret:secret.trim(),...(connectTo==='bybit'?{region}:connectTo==='okx'?{passphrase:passphrase.trim()}:{})};void mutate('/api/connections','POST',credentials,closeConnection);}}>
  {connectTo==='variational'?<label>vr-token<input type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" required minLength={5} maxLength={4096} value={vrToken} onChange={e=>{clearDiagnostic();setVrToken(e.target.value);setFormError('');}}/><span className="help">登录 Omni 网页后，从浏览器 Cookie 中复制 vr-token 的值；只填写值，不带 vr-token= 或完整 Cookie，无需钱包私钥。</span></label>:<>
   <label>API Key<input autoComplete="off" spellCheck={false} autoCapitalize="none" required value={key} onChange={e=>setKey(e.target.value)}/></label>
   <label>API Secret<input type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" required value={secret} onChange={e=>setSecret(e.target.value)}/></label>
   </>}
   {connectTo==='okx'&&<label>Passphrase<input type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" required maxLength={256} value={passphrase} onChange={e=>setPassphrase(e.target.value)}/><span className="help">创建 OKX API 时设置的口令。</span></label>}
   {connectTo==='bybit'&&<label>账户地区<Select value={region} onValueChange={setRegion}><SelectTrigger aria-label="账户地区"><SelectValue/></SelectTrigger><SelectContent>{[['global','国际站'],['nl','荷兰'],['tr','土耳其'],['kz','哈萨克斯坦'],['ge','格鲁吉亚'],['ae','阿联酋'],['eu','欧洲']].map(([v,l])=><SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select></label>}
   <p className="help">{connectTo==='variational'?'vr-token 是网页会话凭据，并非只读 API Key。本账本仅通过 GET 请求读取资产；会话过期后需重新登录 Omni 并更新令牌。若提示 Cloudflare 浏览器验证，表示服务器请求被拦截，不能据此判断令牌失效。':connectTo==='gate'?'仅支持 Gate 国际站 HMAC API。请仅开启钱包读取权限，关闭交易、提现等写入权限；本程序仅向 Gate 发送 GET 请求。':connectTo==='okx'?'仅支持 OKX 国际站实盘 API。只开启读取权限，关闭交易与提现权限；验证账户总资产成功后保存。':connectTo==='binance'?'仅支持 Binance 国际站 HMAC API。开启读取权限，关闭交易、划转和提现等写入权限；首次验证成功后才保存连接与资产估值。':'HMAC 类型只读 API，需要账户与资产读取权限；不读取子账户及理财产品。'}</p>
   {formError&&<p className="error-text" role="alert">{formError}</p>}
  {connectTo==='variational'&&<section className="variational-diagnostic" aria-label="Var 访问诊断"><div className="diagnostic-action"><button type="button" className="button" disabled={busy||vrToken.trim().length<5} onClick={()=>void testVariationalAccess()}>{diagnosticRunning?<><RefreshCw className="loading-spin" size={16} aria-hidden="true"/>测试中…</>:'测试访问'}</button><p className="help">从资产服务所在服务器对比两套请求方式，共四个只读 GET；不保存令牌或连接，不更新资产。</p></div>{diagnosticRunning&&<p className="help" role="status">正在分别使用 Node.js 和 Python 测试登录与资产接口…</p>}{diagnosticError&&<p className="error-text" role="alert">{diagnosticError}</p>}{diagnosticReport&&<VariationalDiagnostics report={diagnosticReport}/>}</section>}
  <div className="form-actions">{connectTo&&ledger.connections[connectTo].configured&&<button type="button" className="button" disabled={busy} onClick={()=>void mutate('/api/connections','DELETE',{exchange:connectTo},closeConnection)}>断开并保留估值</button>}<button className="button primary" disabled={busy}>{busy&&!diagnosticRunning?'验证中…':'验证并连接'}</button></div>
  </form>
 </DialogContent></Dialog>
 <Dialog open={!!detail} onOpenChange={v=>!v&&setDetail(null)}><DialogContent className="detail-dialog"><DialogHeader><DialogTitle>{detail?.project} {detail?.mode==='binance'?'钱包资产明细':detail?.mode==='okx'||detail?.mode==='gate'?'账户资产估值明细':'账户明细'}</DialogTitle><DialogDescription>{detail?.mode==='variational'?'估值时间 ':detail?.mode==='gate'?'获取时间 ':'最近同步 '}{stamp(detail?.updatedAt??null)} · {detail?.mode==='binance'?'钱包资产估值 / USD':detail?.mode==='okx'||detail?.mode==='gate'?'账户资产估值 / USD':'美元净权益'}</DialogDescription></DialogHeader><div className="holdings"><Table><TableHeader><TableRow><TableHead>{detail?.mode==='binance'||detail?.mode==='okx'||detail?.mode==='gate'?'账户 / 估值单位':'账户 / 币种'}</TableHead><TableHead className="numeric">{detail?.mode==='binance'?'折合余额 / USDT':detail?.mode==='okx'||detail?.mode==='gate'?'折合金额 / USD':detail?.mode==='variational'?'净权益 / USDC':'数量'}</TableHead><TableHead className="numeric">美元价值</TableHead></TableRow></TableHeader><TableBody>{detail?.details?.map((b,i)=><TableRow key={i}><TableCell>{b.account}<small className="ticker">{b.coin}</small></TableCell><TableCell className="numeric">{money(b.quantity,6)}</TableCell><TableCell className="numeric">{money(b.value)}</TableCell></TableRow>)}</TableBody></Table></div><p className="help">{detail?.mode==='variational'?'按 Omni 返回的 USDC 净权益与 USDC/USD 报价换算美元估值。净权益已包含未实现盈亏，不再累加保证金、盈亏或持仓名义价值；资产来源未提供时刻；估值时间取账户获取时间与汇率时间中较早者。':detail?.mode==='gate'?'总额直接采用 Gate 返回的账户总资产美元估值；分项是各账户的折合金额，不代表实际 USD 持仓，分项与总额可能存在舍入差异。范围以接口返回为准，不额外累加余额、保证金或未实现盈亏，不自动汇总子账户。Gate 接口数据最多缓存 1 分钟，来源未提供数据时刻，以上展示本次获取时间。':detail?.mode==='okx'?'总额直接采用 OKX 返回的账户总资产美元估值；分项是各账户的折合金额，不代表实际 USD 持仓，分项与总额可能存在舍入差异。不额外累加保证金、未实现盈亏或持仓名义价值，不自动汇总子账户。':detail?.mode==='binance'?'按 Binance 返回的各钱包折合 USDT 余额汇总，再按 USDT/USD 汇率换算；折合余额不是实际 USDT 持仓。不额外累加现货、合约或持仓名义价值，未实现盈亏是否包含以接口返回为准。':'账户合计采用交易所净权益。币种行仅供核对，不将保证金和持仓名义价值再次计入。'}</p></DialogContent></Dialog>
 <Dialog open={!!period} onOpenChange={v=>!v&&setPeriod(null)}><DialogContent className="detail-dialog"><DialogHeader><DialogTitle>{period?.date} 资产快照</DialogTitle><DialogDescription>{period?.archived?'导入前示例记录':period?.future?'原表预填记录':period?.id.startsWith('daily-')?'当日最近一次已保存数据':'原表 '+period?.id} · 总额 $ {money(period?.total??0)}</DialogDescription></DialogHeader>{period?.difference!==0&&<p className="notice">行估值之和与原合计相差 $ {money(period?.difference??0)}。保留原合计，未修改历史。</p>}{formError?<p className="error-text">{formError}</p>:periodRows.length?<div className="holdings">{renderTable(periodRows,false)}</div>:<p className="help">读取快照…</p>}</DialogContent></Dialog>
 <ImportLedgerDialog open={importOpen} onOpenChange={toggleImport} onImported={data=>{ledgerRef.current=data;setLedger(data);setError('');setNow(Date.now());bridgeRef.current?.changed();}}/>
 <Toaster theme="dark" position="bottom-right" richColors/></div>;
}
