// Minimal single-file page: preview, confirm (retries keep the same requestId),
// the accepted job shown apart from the list, stop, acknowledge, adopting a Bybit
// chase strategy, confirming it was not created or releasing it, ANT read-only,
// and the ASTER margin-balance pairs with their transfers.
export const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>执行器原型（模拟）</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;max-width:1080px;color:#1f2328}
h1{font-size:18px} h2{font-size:15px;margin:20px 0 8px} .banner{background:#fff8c5;border:1px solid #d4a72c;padding:8px 12px;border-radius:6px}
fieldset{border:1px solid #d0d7de;border-radius:6px;margin:0 0 12px} label{margin-right:12px} input{width:90px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #eaeef2;padding:4px 6px;text-align:left;vertical-align:top}
.err{color:#cf222e} .ok{color:#1a7f37} .muted{color:#656d76} button{margin-right:6px} input.strategy{width:220px}
</style></head><body>
<h1>统一平台执行器原型 · 原油跨所双腿</h1>
<p class="banner">模拟传输：不会访问任何真实交易所，也不持有真实账户执行权。模拟交易所状态在进程退出后丢失。</p>
<p id="status" class="muted">加载中…</p>
<fieldset><legend>下单预览</legend>
<label>合约 <select id="symbol"><option>CLUSDT</option><option>BZUSDT</option></select></label>
<label>操作 <select id="action"><option value="open">开仓</option><option value="close">平仓</option></select></label>
<label>首腿 <select id="lead"><option value="binance">Binance</option><option value="bybit">Bybit</option></select></label>
<label>首腿方向 <select id="leadSide"><option value="long">多</option><option value="short">空</option></select></label>
<label>首腿方式 <select id="leadType"><option value="market">市价（界限价 IOC）</option><option value="chase">原生追价（仅 Bybit）</option></select></label>
<label>Binance 数量 <input id="qtyBinance" value="1"></label>
<label>Bybit 数量 <input id="qtyBybit" value="1"></label>
<button id="previewBtn">预览</button>
<div id="preview"></div>
</fieldset>
<h2>本次受理任务</h2><div id="accepted" class="muted">尚未提交</div>
<h2>最近任务</h2><div id="jobs"></div>
<h2>ASTER 保证金平衡（模拟）</h2>
<p class="muted">在配对的多侧与空侧子账户之间划转 USD1。结果未知的划转不重发，原请求过期后核对两侧流水并自动结算。</p>
<div id="pairs" class="muted">—</div><div id="transfers"></div>
<h2>ANT 只读（Binance ANTHROPICUSDT）</h2><div id="ant" class="muted">—</div>
<script>
const $ = id => document.getElementById(id);
let previewValue = null, pendingConfirm = null, acceptedJob = null;
// Typed strategy ids survive the periodic re-render.
const strategyInputs = {};
// Like confirm, a retry of a manual action keeps its requestId until it succeeds or its input changes.
const manualRequests = {};
function manualRequestId(jobId, kind, input) {
  const key = jobId + ':' + kind, saved = manualRequests[key];
  if (!saved || saved.input !== input) manualRequests[key] = { input, requestId: crypto.randomUUID() };
  return manualRequests[key].requestId;
}
const STRATEGY_STATUS = { working: '运行中', paused: '已暂停', terminal: '已结束' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path, body) {
  const response = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({ message: '响应无法解析' }));
  if (!response.ok) throw Object.assign(new Error(data.message || '请求失败'), { status: response.status, code: data.code });
  return data;
}
function legsHtml(job) {
  return job.legs.map(leg => { const op = leg.operation; return esc(leg.venue) + ' ' + esc(leg.side) + ' 计划 ' + esc(leg.plannedQuantity) + (leg.priceBound ? ' 界限 ' + esc(leg.priceBound) : '') + (op ? ' · ' + esc(op.state) + strategyHtml(op) + ' 累计成交 ' + esc(leg.filledQuantity) + (leg.attempts > 1 ? '（' + esc(leg.attempts) + ' 笔，末笔 ' + esc(op.filledQuantity) + '）' : '') + (op.averagePrice ? ' @ ' + esc(op.averagePrice) : '') + (op.note ? ' <span class="muted">' + esc(op.note) + '</span>' : '') : ' · 未发送'); }).join('<br>');
}
function strategyHtml(op) {
  if (op.kind !== 'strategy') return '';
  return ' · 追价策略 ' + (op.remoteId ? esc(op.remoteId) : '编号未知') + (op.strategyStatus ? ' ' + esc(STRATEGY_STATUS[op.strategyStatus] || op.strategyStatus) : '')
    + (op.strategyStatus === 'terminal' && op.childrenSettled === false ? '（子单未结清）' : '') + (op.adoptedAt ? '（人工认领）' : '') + (op.releasedAt ? '（已强制释放）' : '');
}
const SIDE = { long: '多侧', short: '空侧' };
const TRANSFER_STATE = { prepared: '已落盘', sending: '发送中', acknowledged: '已回执，待刷新余额', unknown: '结果未知，待到期结算', confirmed: '已执行', rejected: '被拒绝', 'not-sent': '未发送', 'expired-not-executed': '到期结算：未执行', 'expired-unverified': '到期结算：是否执行未能确认' };
// A switch keeps its requestId only while no answer arrived, so a lost response is replayed safely; any answer, refusals included, ends that request.
const pairRequests = {};
const clock = at => at ? new Date(at).toLocaleTimeString() : '—';
function transferText(item) {
  return esc(SIDE[item.sourceSide]) + ' → ' + esc(SIDE[item.destinationSide]) + ' ' + esc(item.amount) + ' ' + esc(item.asset) + ' · ' + esc(TRANSFER_STATE[item.state] || item.state)
    + (item.readyAt ? '（' + esc(clock(item.readyAt)) + ' 后结算）' : '') + (item.recovered ? '（接管恢复）' : '');
}
function pairRow(pair) {
  const side = name => pair.balances ? '可用 ' + esc(pair.balances[name].available) + ' / 权益 ' + esc(pair.balances[name].equity) + ' / 可划 ' + esc(pair.balances[name].maxWithdraw) : '未读取';
  const wait = pair.blocked || (pair.cooldownUntil > Date.now() ? '冷却至 ' + clock(pair.cooldownUntil) : '');
  return '<tr><td>' + esc(pair.id) + '<br><span class="muted">主 ' + esc(pair.mainAccountId) + '</span></td><td>' + (pair.enabled ? '已启用' : '已停用') + '</td><td>多侧 ' + esc(pair.long) + '：' + side('long') + '<br>空侧 ' + esc(pair.short) + '：' + side('short') + '</td><td>'
    + (pair.current ? transferText(pair.current) : '无未结清划转') + '</td><td>' + esc(wait) + (wait && pair.note ? '；' : '') + esc(pair.note) + '</td><td><button data-pair="' + esc(pair.id) + '" data-enable="' + (pair.enabled ? '0' : '1') + '">' + (pair.enabled ? '停用' : '启用') + '</button></td></tr>';
}
function transferRow(item) {
  return '<tr><td>' + esc(item.id.slice(0, 8)) + '</td><td>' + esc(item.pairId) + '</td><td>' + esc(clock(item.preparedAt)) + '</td><td>' + transferText(item) + '</td><td>' + esc(item.basis) + (item.receipt ? ' ' + esc(item.receipt) : '') + '</td><td>' + esc(item.labelNote || item.note) + '</td></tr>';
}
function jobRow(job) {
  const pending = job.status === 'attention' && job.strategyPending;
  const actions = (['accepted','running'].includes(job.status) && !job.stopRequested ? '<button data-stop="' + esc(job.id) + '">停止</button>' : '')
    + (pending ? '<input class="strategy" data-strategy-input="' + esc(job.id) + '" placeholder="交易所显示的策略编号" value="' + esc(strategyInputs[job.id] || '') + '"> <button data-adopt="' + esc(job.id) + '">认领策略</button><button data-notcreated="' + esc(job.id) + '">确认未创建</button><button data-release="' + esc(job.id) + '">强制释放（策略可能已成交）</button>' : '')
    + (job.status === 'attention' && job.locked && !pending ? '<button data-ack="' + esc(job.id) + '">已人工处理，释放合约</button>' : '');
  return '<tr><td>' + esc(job.id.slice(0, 8)) + '</td><td>' + esc(job.status) + (job.stopRequested ? '（已请求停止）' : '') + (job.holdNewSends ? '（恢复中，不再发送新委托）' : '') + '</td><td>' + legsHtml(job) + '</td><td>' + esc(job.reason) + '</td><td>' + actions + '</td></tr>';
}
$('previewBtn').onclick = async () => {
  const lead = $('lead').value, other = lead === 'binance' ? 'bybit' : 'binance', leadSide = $('leadSide').value, leadType = $('leadType').value;
  const qty = { binance: $('qtyBinance').value.trim(), bybit: $('qtyBybit').value.trim() };
  const intent = { market: 'oil', preset: 'cross-exchange', symbol: $('symbol').value, action: $('action').value, timeoutMs: 60000,
    legs: [{ venue: lead, side: leadSide, quantity: qty[lead], orderType: leadType }, { venue: other, side: leadSide === 'long' ? 'short' : 'long', quantity: qty[other], orderType: 'market' }] };
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
document.addEventListener('input', event => {
  const id = event.target.dataset?.strategyInput;
  if (id) strategyInputs[id] = event.target.value.trim();
});
document.addEventListener('click', async event => {
  const { pair, enable } = event.target.dataset || {};
  if (!pair) return;
  const key = pair + ':' + enable;
  try {
    await api('/api/transfer-pairs/' + pair + (enable === '1' ? '/enable' : '/disable'), { requestId: pairRequests[key] || (pairRequests[key] = crypto.randomUUID()) });
    delete pairRequests[key];
    refresh();
  } catch (error) {
    if (error.status) delete pairRequests[key];
    alert(error.message);
  }
});
document.addEventListener('click', async event => {
  const { stop, ack, adopt, notcreated, release } = event.target.dataset || {};
  if (!stop && !ack && !adopt && !notcreated && !release) return;
  try {
    if (adopt) {
      const strategyId = strategyInputs[adopt];
      if (!strategyId) { alert('请先填写交易所显示的策略编号'); return; }
      await api('/api/jobs/' + adopt + '/adopt-strategy', { requestId: manualRequestId(adopt, 'adopt', strategyId), strategyId });
      delete strategyInputs[adopt]; delete manualRequests[adopt + ':adopt'];
    } else if (notcreated) {
      if (!confirm('确认已在交易所核对，该合约没有本次下单产生的追价策略？')) return;
      await api('/api/jobs/' + notcreated + '/confirm-not-created', { requestId: manualRequestId(notcreated, 'notcreated', '') });
      delete manualRequests[notcreated + ':notcreated'];
    } else if (release) {
      if (!confirm('强制释放：本次追价策略可能已在交易所创建并成交，执行器将不再认领、核对或停止它，敞口与仍在运行的策略须由你在交易所自行处理。确定释放？')) return;
      await api('/api/jobs/' + release + '/release-strategy', { requestId: manualRequestId(release, 'release', ''), acknowledgeRisk: true });
      delete manualRequests[release + ':release'];
    } else await api('/api/jobs/' + (stop || ack) + (stop ? '/stop' : '/acknowledge'), { requestId: crypto.randomUUID() });
    refresh();
  }
  catch (error) { alert(error.message); }
});
async function refresh() {
  try {
    const state = await api('/api/state');
    $('status').textContent = '写者代次 ' + state.generation + (state.retired ? '（已失去写入权，请重启）' : '') + ' · 传输 ' + state.transport + ' · 账户 ' + state.accounts.map(a => a.venue + ' ' + a.accountMode + ' ' + a.accountId + ' v' + a.credentialVersion).join('，');
    // Re-rendering while a strategy id is being typed would take the focus away.
    const typing = document.activeElement?.dataset?.strategyInput;
    if (!typing) $('jobs').innerHTML = '<table><tr><th>任务</th><th>状态</th><th>两腿</th><th>说明</th><th></th></tr>' + state.jobs.map(jobRow).join('') + '</table>';
    $('pairs').innerHTML = state.transfers.pairs.length ? '<table><tr><th>配对</th><th>开关</th><th>两侧余额（USD1）</th><th>当前划转</th><th>说明</th><th></th></tr>' + state.transfers.pairs.map(pairRow).join('') + '</table>' : '没有划转配对';
    if (state.transfers.corruptPairs.length) $('pairs').innerHTML += '<p>配对记录损坏，未列出也不会划转，需人工处置：' + esc(state.transfers.corruptPairs.join('，')) + '</p>';
    $('transfers').innerHTML = state.transfers.recent.length ? '<table><tr><th>划转</th><th>配对</th><th>时间</th><th>方向、金额与状态</th><th>结算依据</th><th>备注</th></tr>' + state.transfers.recent.map(transferRow).join('') + '</table>' : '';
    if (acceptedJob) { const latest = state.jobs.find(job => job.id === acceptedJob.id); if (latest) { acceptedJob = latest; if (!typing) $('accepted').innerHTML = '<table>' + jobRow(latest) + '</table>'; } }
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
