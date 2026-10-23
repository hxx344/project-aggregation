// Local-only browser fixture: real OilPanel and bridge, simulated parent, no account APIs.
// node --experimental-strip-types tests/oil-trades-server.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { fill, fillsReply } from './oil-trades-fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), port = Number(process.env.OIL_TRADES_BROWSER_PORT ?? 39186);
const candles = JSON.parse(await readFile(new URL('../public/oil/data/binance-15m.json', import.meta.url), 'utf8'));
const latest = candles.data.at(-1).time;
const make = (key, ago, fields = {}) => fill({ key, time: new Date(latest - ago).toISOString(), ...fields });
const bz = { base: 'BZ', symbol: 'BZUSDT', quantityUnit: 'BZ', price: '112', side: 'sell', positionAfter: '-2' };
const items = [
  make('entry-cl', 2 * 86400_000), make('entry-bz', 2 * 86400_000 - 1000, bz),
  make('exit-cl', 3 * 3600_000, { side: 'sell', positionBefore: '2', positionAfter: '0' }),
  make('exit-bz', 3 * 3600_000 - 1000, { ...bz, side: 'buy', positionBefore: '-2', positionAfter: '0' }),
  make('cross-cl', 3600_000, { positionBefore: '-1', positionAfter: '1' }),
  make('unknown-cl', 300_000, { account: '<img src=x onerror=alert(1)>', positionBefore: null, positionAfter: null, realizedPnl: null }),
];
const reply = fillsReply({ items, incomplete: true, generatedAt: new Date(latest).toISOString() });
const vite = await createViteServer({
  root, configLoader: 'runner', cacheDir: '.build-cache/oil-trades-vite',
  server: { middlewareMode: true, hmr: false, allowedHosts: ['hub.localhost', 'p-aaaaaaaaaaaaaaaaaaaaaaaa.hub.localhost'] },
  appType: 'custom',
});
const host = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>套利成交桥测试</title>
<style>body{margin:0;background:#10151e;color:#ddd;font:14px sans-serif}nav{padding:8px;display:flex;gap:8px;flex-wrap:wrap}button{padding:8px}iframe{border:0;width:100%;height:calc(100vh - 58px)}</style>
<nav><button id="pause">暂停</button><button id="resume">恢复</button><button id="fail">刷新失败</button><button id="success">正常回复</button><button id="unsupported">旧工作台</button><button id="handshake">重新握手</button></nav>
<iframe title="监控成交测试" src="http://p-aaaaaaaaaaaaaaaaaaaaaaaa.hub.localhost:${port}/__monitor"></iframe>
<script type="module">
const frame=document.querySelector('iframe'), target=new URL(frame.src).origin, envelope={channel:'project-hub',version:1};
const fixture=window.fixture={requests:[],status:'ok',pending:false,silent:false,supported:true,active:true,ready:false};
const send=value=>frame.contentWindow.postMessage({...envelope,...value},target);
const ready=()=>send({type:'ready',role:'host',capabilities:['activity','positions',...(fixture.supported?['fills']:[])]});
const activity=value=>{fixture.active=value;send({type:'activity',active:value,backgroundUpdates:true})};
fixture.activity=activity;fixture.handshake=ready;
window.addEventListener('message',event=>{
 if(event.source!==frame.contentWindow||event.origin!==target||event.data?.channel!=='project-hub')return;
 const data=event.data;
 if(data.type==='ready'&&!fixture.ready){fixture.ready=true;ready();activity(true)}
 if(data.type==='fills-request'){
  fixture.requests.push(data); if(fixture.silent)return;
  send({...${JSON.stringify(reply).replace(/</g, '\\u003c')},requestId:data.requestId,status:fixture.status,pending:fixture.pending});
 }
});
document.getElementById('pause').onclick=()=>activity(false);
document.getElementById('resume').onclick=()=>activity(true);
document.getElementById('fail').onclick=()=>{fixture.status='unavailable';activity(false);setTimeout(()=>activity(true),30)};
document.getElementById('success').onclick=()=>{fixture.status='ok';fixture.supported=true;ready();activity(false);setTimeout(()=>activity(true),30)};
document.getElementById('unsupported').onclick=()=>{fixture.supported=false;ready()};
document.getElementById('handshake').onclick=ready;
</script></html>`;
const server = createServer(async (request, response) => {
  if (request.url === '/__host') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(host); return; }
  if (request.url === '/__monitor') {
    const html = await vite.transformIndexHtml('/__monitor', '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>原油成交</title><body style="margin:0;background:var(--background)"><div id="root"></div><script type="module" src="/tests/oil-trades-fixture.tsx"></script></body></html>');
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return;
  }
  if (request.url === '/api/monitors/oil/candles/15m') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(candles)); return; }
  if (request.url.startsWith('/api/')) { response.writeHead(503).end('{}'); return; }
  vite.middlewares(request, response, () => response.writeHead(404).end());
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
process.stdout.write(`Oil trade fixture: http://hub.localhost:${port}/__host\n`);
async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await vite.close(); }
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
