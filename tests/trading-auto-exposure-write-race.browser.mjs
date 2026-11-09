// Isolated production-entry regression: a saved rule with a delayed response invalidates an older exposure read.
async (page) => {
 const origin='http://127.0.0.1:4175', stamp=()=>new Date().toISOString();
 const assert=(condition,message)=>{if(!condition)throw new Error(message);};
 let version='old-version', releaseExposure=null, releaseWrite=null, writes=0;
 const config={name:'竞态规则',market:'oil',exchange:'binance',direction:'short',openThreshold:'4',closeThreshold:'2',equalSize:'1',orderType:'chase',confirmSamples:3,maxOpensPerDay:3,batchCount:1,batchIntervalMs:1000,repriceIntervalMs:5000,timeoutMs:300000};
 const rule={id:'00000000-0000-4000-8000-000000000001',revision:1,enabled:false,mode:'live',observing:false,createdAt:stamp(),title:'竞态规则',config,state:{phase:'idle',jobId:null,held:null,opensToday:0,failures:0,retryAt:null,reason:null,events:[]},spread:{label:'BZ − CL',unit:'USDT/桶'},live:null};
 const auto=()=>({generatedAt:stamp(),exposureVersion:version,maintenance:false,rules:[structuredClone(rule)]});
 const exposure=()=>({generatedAt:stamp(),startedAt:stamp(),expiresAt:new Date(Date.now()+10000).toISOString(),maxAgeMs:10000,rulesVersion:version,complete:true,scope:'fixture',gaps:[],groups:[{id:'short',exchange:'binance',symbol:'BZUSDT',accountKey:'fixture',accountLabel:'fixture',instrumentId:'BZUSDT',unit:'桶',contractSize:'1',quoteAsset:'USDT',side:'short',currentAccount:true,accountAt:stamp(),quoteAt:stamp(),target:{quantity:'1',knownQuantity:'1',unknownCount:0,notional:'70'},held:{quantity:'0',knownQuantity:'0',unknownCount:0,notional:'0'},actual:{quantity:'0',notional:'0'},sharedRuleIds:[rule.id],rules:[],jobs:[],orders:{buyQuantity:'0',sellQuantity:'0',unknownCount:0,items:[]},gaps:[]}]});
 await page.context().setOffline(false); await page.setViewportSize({width:1440,height:1000});
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
 await page.route('**/api/**',async route=>{
  const req=route.request(), url=new URL(req.url()), send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(req.method()==='PUT' && url.pathname.endsWith('/'+rule.id)) {
   writes++; rule.config=req.postDataJSON().config; rule.revision++; version='new-version';
   const payload=auto(); await new Promise(resolve=>{releaseWrite=resolve;}); return send(payload);
  }
  if(req.method()!=='GET')throw new Error('Unexpected write '+req.method()+' '+url.pathname);
  if(url.pathname==='/api/session')return send({authenticated:true,csrfToken:'fixture'});
  if(url.pathname==='/api/overview/events')return route.fulfill({status:200,contentType:'text/event-stream',body:`data: ${JSON.stringify({projects:[],generatedAt:stamp()})}\n\n`});
  if(url.pathname==='/api/overview'||url.pathname==='/api/projects')return send({projects:[],generatedAt:stamp()});
  if(url.pathname==='/api/trading/execution')return send({generatedAt:stamp(),connections:[],positions:[],jobs:[]});
  if(url.pathname==='/api/trading/execution/quotes')return send({generatedAt:stamp(),maxAgeMs:10000,books:[]});
  if(url.pathname==='/api/trading/execution/auto')return send(auto());
  if(url.pathname==='/api/trading/execution/auto/exposure') {const payload=exposure();await new Promise(resolve=>{releaseExposure=resolve;});return send(payload);}
  return send({error:'outside fixture'},503);
 });
 await page.goto(origin+'/?view=trading&tradingSection=auto');
 const panel=page.locator('section.auto-panel'), exposurePanel=page.locator('section.auto-exposure');
 await panel.getByRole('button',{name:'修改',exact:true}).click();
 await panel.getByLabel('每腿桶数 · 桶',{exact:true}).fill('2');
 await exposurePanel.getByRole('button',{name:'刷新敞口'}).click();
 for(let i=0;!releaseExposure&&i<100;i++)await page.waitForTimeout(10);
 assert(releaseExposure,'exposure response held');
 await panel.getByRole('button',{name:'保存修改',exact:true}).click();
 for(let i=0;!releaseWrite&&i<100;i++)await page.waitForTimeout(10);
 assert(releaseWrite&&version==='new-version','server mutation committed but response held');
 releaseExposure(); await page.waitForTimeout(200);
 const during=await exposurePanel.innerText();
 const oldExposureShown=await exposurePanel.getByRole('article').count()===1 && during.includes('配置目标合计：1 桶');
 const savePending=await panel.getByRole('button',{name:'保存修改',exact:true}).isDisabled();
 releaseWrite(); await page.waitForTimeout(200);
 const afterCount=await exposurePanel.getByRole('article').count();
 assert(!oldExposureShown&&savePending,'a pending rule write must retract old exposure and reject its late response');
 assert(afterCount===0,'eventual write response retracts old exposure');
 return {serverEqualSize:rule.config.equalSize,serverVersion:version,oldExposureShown,savePending,afterWriteResponseArticleCount:afterCount,fixtureWrites:writes};
}

