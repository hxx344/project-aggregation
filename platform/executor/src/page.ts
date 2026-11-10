// Minimal single-file page: preview, confirm (retries keep the same requestId),
// the accepted job shown apart from the list, stop, acknowledge and ANT read-only.
export const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>执行器原型（模拟）</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;max-width:1080px;color:#1f2328}
h1{font-size:18px} h2{font-size:15px;margin:20px 0 8px} .banner{background:#fff8c5;border:1px solid #d4a72c;padding:8px 12px;border-radius:6px}
fieldset{border:1px solid #d0d7de;border-radius:6px;margin:0 0 12px} label{margin-right:12px} input{width:90px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #eaeef2;padding:4px 6px;text-align:left;vertical-align:top}
.err{color:#cf222e} .ok{color:#1a7f37} .muted{color:#656d76} button{margin-right:6px}
</style></head><body>
<h1>统一平台执行器原型 · 原油跨所双腿</h1>
<p class="banner">模拟传输：不会访问任何真实交易所，也不持有真实账户执行权。模拟交易所状态在进程退出后丢失。</p>
<p id="status" class="muted">加载中…</p>
<fieldset><legend>下单预览</legend>
<label>合约 <select id="symbol"><option>CLUSDT</option><option>BZUSDT</option></select></label>
<label>操作 <select id="action"><option value="open">开仓</option><option value="close">平仓</option></select></label>
<label>首腿 <select id="lead"><option value="binance">Binance</option><option value="bybit">Bybit</option></select></label>
<label>首腿方向 <select id="leadSide"><option value="long">多</option><option value="short">空</option></select></label>
<label>Binance 数量 <input id="qtyBinance" value="1"></label>
<label>Bybit 数量 <input id="qtyBybit" value="1"></label>
<button id="previewBtn">预览</button>
<div id="preview"></div>
</fieldset>
<h2>本次受理任务</h2><div id="accepted" class="muted">尚未提交</div>
<h2>最近任务</h2><div id="jobs"></div>
<h2>ANT 只读（Binance ANTHROPICUSDT）</h2><div id="ant" class="muted">—</div>
<script>
const $ = id => document.getElementById(id);
let previewValue = null, pendingConfirm = null, acceptedJob = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path, body) {
  const response = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({ message: '响应无法解析' }));
  if (!response.ok) throw Object.assign(new Error(data.message || '请求失败'), { status: response.status, code: data.code });
  return data;
}
function legsHtml(job) {
  return job.legs.map(leg => { const op = leg.operation; return esc(leg.venue) + ' ' + esc(leg.side) + ' 计划 ' + esc(leg.plannedQuantity) + (leg.priceBound ? ' 界限 ' + esc(leg.priceBound) : '') + (op ? ' · ' + esc(op.state) + ' 累计成交 ' + esc(leg.filledQuantity) + (leg.attempts > 1 ? '（' + esc(leg.attempts) + ' 笔，末笔 ' + esc(op.filledQuantity) + '）' : '') + (op.averagePrice ? ' @ ' + esc(op.averagePrice) : '') + (op.note ? ' <span class="muted">' + esc(op.note) + '</span>' : '') : ' · 未发送'); }).join('<br>');
}
function jobRow(job) {
  const actions = (['accepted','running'].includes(job.status) && !job.stopRequested ? '<button data-stop="' + esc(job.id) + '">停止</button>' : '') + (job.status === 'attention' && job.locked ? '<button data-ack="' + esc(job.id) + '">已人工处理，释放合约</button>' : '');
  return '<tr><td>' + esc(job.id.slice(0, 8)) + '</td><td>' + esc(job.status) + (job.stopRequested ? '（已请求停止）' : '') + (job.holdNewSends ? '（恢复中，不再发送新委托）' : '') + '</td><td>' + legsHtml(job) + '</td><td>' + esc(job.reason) + '</td><td>' + actions + '</td></tr>';
}
$('previewBtn').onclick = async () => {
  const lead = $('lead').value, other = lead === 'binance' ? 'bybit' : 'binance', leadSide = $('leadSide').value;
  const qty = { binance: $('qtyBinance').value.trim(), bybit: $('qtyBybit').value.trim() };
  const intent = { market: 'oil', preset: 'cross-exchange', symbol: $('symbol').value, action: $('action').value, timeoutMs: 60000,
    legs: [{ venue: lead, side: leadSide, quantity: qty[lead], orderType: 'market' }, { venue: other, side: leadSide === 'long' ? 'short' : 'long', quantity: qty[other], orderType: 'market' }] };
  $('preview').innerHTML = '预览中…'; previewValue = null; pendingConfirm = null;
  try {
    previewValue = await api('/api/preview', intent);
    $('preview').innerHTML = previewValue.legs.map(leg => esc(leg.venue) + ' ' + esc(leg.orderSide) + ' ' + esc(leg.quantity) + ' ' + esc(leg.symbol) + '（买一 ' + esc(leg.quote.bid) + ' / 卖一 ' + esc(leg.quote.ask) + '，现有 ' + esc(leg.baseline) + '）').join('<br>')
      + '<br><span class="muted">' + previewValue.notes.map(esc).join(' ') + '</span><br><button id="confirmBtn">确认执行（模拟）</button><div id="confirmMsg"></div>';
    $('confirmBtn').onclick = confirmPreview;
  } catch (error) { $('preview').innerHTML = '<span class="err">' + esc(error.message) + '</span>'; }
};
async function confirmPreview() {
  // A lost response is retried with the same requestId so the executor returns the original job.
  if (!pendingConfirm || pendingConfirm.previewId !== previewValue.id) pendingConfirm = { previewId: previewValue.id, requestId: crypto.randomUUID(), confirmLive: true };
  try {
    const result = await api('/api/confirm', pendingConfirm);
    acceptedJob = result.job;
    $('accepted').innerHTML = (result.duplicate ? '（重复提交，返回原任务）' : '') + '<table>' + jobRow(acceptedJob) + '</table>';
    $('preview').innerHTML = '<span class="ok">已受理</span>';
  } catch (error) {
    // Written beside the button, never over it, so the retry keeps its handler.
    $('confirmMsg').innerHTML = '<span class="err">' + esc(error.message) + (error.status ? '' : '（结果未知，可再次点击确认，沿用同一请求编号）') + '</span>';
  }
}
document.addEventListener('click', async event => {
  const stop = event.target.dataset?.stop, ack = event.target.dataset?.ack;
  if (!stop && !ack) return;
  try { await api('/api/jobs/' + (stop || ack) + (stop ? '/stop' : '/acknowledge'), { requestId: crypto.randomUUID() }); refresh(); }
  catch (error) { alert(error.message); }
});
async function refresh() {
  try {
    const state = await api('/api/state');
    $('status').textContent = '写者代次 ' + state.generation + (state.retired ? '（已失去写入权，请重启）' : '') + ' · 传输 ' + state.transport + ' · 账户 ' + state.accounts.map(a => a.venue + ' ' + a.accountMode + ' ' + a.accountId + ' v' + a.credentialVersion).join('，');
    $('jobs').innerHTML = '<table><tr><th>任务</th><th>状态</th><th>两腿</th><th>说明</th><th></th></tr>' + state.jobs.map(jobRow).join('') + '</table>';
    if (acceptedJob) { const latest = state.jobs.find(job => job.id === acceptedJob.id); if (latest) { acceptedJob = latest; $('accepted').innerHTML = '<table>' + jobRow(latest) + '</table>'; } }
  } catch (error) {
    // A failed refresh never clears the accepted job or the last known list.
    $('status').innerHTML = '<span class="err">刷新失败：' + esc(error.message) + '</span>';
  }
  try {
    const ant = await api('/api/observe?venue=binance&symbol=ANTHROPICUSDT');
    $('ant').textContent = '买一 ' + ant.quote.bid + ' / 卖一 ' + ant.quote.ask + ' · 年龄 ' + ant.ageMs + ' 毫秒 · 持仓 多 ' + (ant.position?.long ?? '—') + ' 空 ' + (ant.position?.short ?? '—') + ' · 只读，不可执行';
  } catch (error) { $('ant').innerHTML = '<span class="err">' + esc(error.message) + '</span>'; }
}
refresh(); setInterval(refresh, 2000);
</script></body></html>`;
