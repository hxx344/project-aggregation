import http from 'node:http';
import { createHash } from 'node:crypto';
const loginSessions = new Map();
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UpstreamError extends Error {
  constructor(code, message, statusCode) { super(message); this.code = code; if (statusCode !== undefined) this.statusCode = statusCode; }
}

export function blockedAddress(address) {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower.startsWith('::ffff:')) {
    const suffix = lower.slice(7);
    if (suffix.includes('.')) return blockedAddress(suffix);
    const parts = suffix.split(':');
    if (parts.length === 2) return blockedAddress(`${parseInt(parts[0], 16) >>> 8}.${parseInt(parts[0], 16) & 255}.${parseInt(parts[1], 16) >>> 8}.${parseInt(parts[1], 16) & 255}`);
  }
  if (lower.includes(':')) return lower === '::' || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  const octets = lower.split('.').map(Number);
  return octets[0] === 0 || octets[0] >= 224 || (octets[0] === 169 && octets[1] === 254) || lower === '100.100.100.200';
}

export function validateUrl(value, { api = false } = {}) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) throw new Error('地址格式不正确');
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的 http 或 https 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (api && (url.search || url.hash))) throw new Error('服务地址仅支持 http/https，不能含凭据；接口地址不能含查询参数或锚点');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if ((isIP(hostname) && blockedAddress(hostname)) || /^(metadata|instance-data)(\.|$)/.test(hostname) || hostname.endsWith('.metadata.google.internal')) throw new Error('不允许访问云元数据或链路本地地址');
  return url.toString().replace(/\/$/, '');
}

export function validateAuthOrigin(value = '') {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value || /[?#]/.test(value)) throw new Error('认证来源必须是完整的 http/https 来源，不能含路径、查询参数、锚点或凭据');
  let url;
  try { url = new URL(value); } catch { throw new Error('认证来源格式不正确'); }
  if (!/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.username || url.password) throw new Error('认证来源只能包含 http/https 协议、主机名和可选端口');
  return url.origin;
}
// Pin the validated DNS answer to this connection, including when private hosts are allowed.
export async function requestJson(base, path, { method = 'GET', headers = {}, body, deadline, signal, limit = 1024 * 1024 } = {}) {
  const target = new URL(base.replace(/\/$/, '') + path);
  if (target.origin !== new URL(base).origin) throw new UpstreamError('invalid', '接口地址不在配置的服务内');
  const remaining = Math.max(1, deadline - Date.now());
  if (remaining <= 1 || signal?.aborted) throw new UpstreamError('timeout', '服务响应超时');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, remaining);
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new UpstreamError('timeout', '服务响应超时')), { once: true })),
    ]);
    if (!addresses.length || addresses.some(({ address }) => blockedAddress(address))) throw new UpstreamError('invalid', '服务地址解析到不允许访问的地址');
    const address = addresses[0];
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const req = (target.protocol === 'https:' ? https : http).request(target, {
        method, signal: controller.signal,
        lookup: (_name, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
        headers: { Accept: 'application/json', ...headers, ...(serialized ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized) } : {}) },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); reject(new UpstreamError('invalid', '服务返回重定向，请配置最终服务地址')); return; }
        if ([401, 403, 429].includes(res.statusCode)) { res.destroy(); reject(new UpstreamError('unauthorized', res.statusCode === 429 ? '上游登录限流，请稍后重试' : '需要有效的网页登录凭据，请检查项目设置', res.statusCode)); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); reject(new UpstreamError('offline', `上游服务响应异常（${res.statusCode}）`, res.statusCode)); return; }
        const chunks = []; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > limit) { res.destroy(); reject(new UpstreamError('invalid', '上游响应超过大小限制')); } else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => { try { resolve({ data: JSON.parse(Buffer.concat(chunks).toString('utf8')), cookies: res.headers['set-cookie'] || [] }); } catch { reject(new UpstreamError('invalid', '上游响应不是有效 JSON')); } });
      });
      req.on('error', reject); if (serialized) req.write(serialized); req.end();
    });
  } catch (error) {
    if (controller.signal.aborted) throw new UpstreamError('timeout', '服务响应超时');
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('offline', '无法连接上游服务，请检查地址和服务状态');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

const finite = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
const iso = value => { const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value); return value != null && Number.isFinite(date.getTime()) ? date.toISOString() : null; };
const oldest = values => values.length > 0 && values.every(Boolean) ? [...values].sort()[0] : null;
const strictDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && iso(value) ? iso(value) : null;
const sum = values => values.length && values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null;
const metric = (key, label, value, unit, detail) => ({ key, label, value, ...(unit ? { unit } : {}), ...(detail ? { detail } : {}) });
const diagnosticText = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : fallback;
function diagnosticMessage(base, reasons) {
  let message = base;
  for (const [index, reason] of reasons.entries()) {
    if (message.length + reason.length + 40 > 500) return `${message}；另有 ${reasons.length - index} 项异常，请进入项目查看`;
    message += `；${reason}`;
  }
  return message;
}

export function standardSummary(raw) {
  if (!raw || ![1, 2].includes(raw.schemaVersion) || !raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data) || Object.keys(raw).some(key => !['schemaVersion', 'data'].includes(key))) throw new UpstreamError('invalid', '标准协议版本或顶层字段不正确');
  const data = raw.data;
  const v2 = raw.schemaVersion === 2;
  const allowed = v2 ? ['updatedAt', 'metrics', 'trend', 'health', 'freshness'] : ['updatedAt', 'metrics', 'trend'];
  if (Object.keys(data).some(key => !allowed.includes(key)) || (!(v2 && data.updatedAt === null) && !strictDate(data.updatedAt)) || new Date(data.updatedAt).getTime() > Date.now() + 60000 || !Array.isArray(data.metrics) || data.metrics.length > 24) throw new UpstreamError('invalid', '标准协议摘要字段不正确');
  if (v2 && (!data.health || typeof data.health !== 'object' || Array.isArray(data.health) || Object.keys(data.health).some(key => !['state', 'message', 'staleAfterSeconds'].includes(key)) || !['online', 'partial', 'stale', 'offline'].includes(data.health.state) || typeof data.health.message !== 'string' || data.health.message.length > 500 || !Number.isInteger(data.health.staleAfterSeconds) || data.health.staleAfterSeconds < 1 || data.health.staleAfterSeconds > 86400 || (data.freshness !== undefined && !['static', 'dynamic'].includes(data.freshness)))) throw new UpstreamError('invalid', '标准协议健康状态不正确');
  const keys = new Set();
  for (const item of data.metrics) {
    if (!item || Object.keys(item).some(key => !['key', 'label', 'value', 'unit', 'detail'].includes(key)) || typeof item.key !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.key) || keys.has(item.key) || typeof item.label !== 'string' || !item.label.length || item.label.length > 80 || !(item.value === null || (typeof item.value === 'number' && Number.isFinite(item.value)) || (typeof item.value === 'string' && item.value.length <= 160)) || (item.unit !== undefined && (typeof item.unit !== 'string' || item.unit.length > 24)) || (item.detail !== undefined && (typeof item.detail !== 'string' || item.detail.length > 240))) throw new UpstreamError('invalid', '标准协议指标格式不正确');
    keys.add(item.key);
  }
  if (data.trend !== undefined && (!Array.isArray(data.trend) || data.trend.length > 366 || data.trend.some(point => !point || Object.keys(point).some(key => !['at', 'value'].includes(key)) || !strictDate(point.at) || typeof point.value !== 'number' || !Number.isFinite(point.value)))) throw new UpstreamError('invalid', '标准协议趋势格式不正确');
  return { metrics: data.metrics, updatedAt: strictDate(data.updatedAt), ...(data.trend ? { trend: data.trend.map(point => ({ at: strictDate(point.at), value: point.value })).sort((a, b) => a.at.localeCompare(b.at)) } : {}), ...(v2 ? { state: data.health.state, staleAfterSeconds: data.health.staleAfterSeconds, ...(data.freshness ? { freshness: data.freshness } : {}), message: data.health.message } : { message: '服务数据已更新' }) };
}

// Login requests are shared while each caller retains its own deadline and cancellation.
const loginFlights = new Map();
function waitWithin(promise, deadline, signal) {
  if (signal?.aborted || deadline <= Date.now()) return Promise.reject(new UpstreamError('timeout', '服务响应超时'));
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value); };
    const abort = () => finish(reject, new UpstreamError('timeout', '服务响应超时'));
    const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}
async function authenticatedSession(project, credentials, { request, deadline, signal }) {
  const authOrigin = project.authOrigin || new URL(project.apiUrl).origin;
  if (!credentials?.password) return { headers: { Origin: authOrigin } };
  const key = createHash('sha256').update(JSON.stringify([project.apiUrl, project.adapter, authOrigin, credentials.password])).digest('hex');
  const now = Date.now();
  for (const [storedKey, value] of loginSessions) if (value.expires <= now) loginSessions.delete(storedKey);
  let session = loginSessions.get(key);
  if (!session) {
    let flight = loginFlights.get(key);
    if (!flight) {
      flight = { controller: new AbortController(), waiters: 0, settled: false, promise: null };
      loginFlights.set(key, flight);
      flight.promise = Promise.resolve().then(async () => {
        const loginDeadline = Date.now() + 60000;
        const response = await waitWithin(Promise.resolve().then(() => request(project.apiUrl, '/api/login', {
          deadline: loginDeadline, signal: flight.controller.signal, method: 'POST', headers: { Origin: authOrigin }, body: { password: credentials.password },
        })), loginDeadline, flight.controller.signal);
        const name = project.adapter === 'aster' ? 'aster_session' : 'asset_session';
        const cookie = response.cookies?.find(value => value.startsWith(name + '='));
        if (!cookie) throw new UpstreamError('unauthorized', '上游没有返回有效的登录会话');
        const value = { cookie: cookie.split(';')[0], expires: Date.now() + 11 * 3600000 };
        if (!flight.controller.signal.aborted && loginFlights.get(key) === flight) {
          if (loginSessions.size >= 100) loginSessions.delete(loginSessions.keys().next().value);
          loginSessions.set(key, value);
        }
        return value;
      }).finally(() => {
        flight.settled = true;
        if (loginFlights.get(key) === flight) loginFlights.delete(key);
      });
      flight.promise.catch(() => {});
    }
    flight.waiters++;
    try { session = await waitWithin(flight.promise, deadline, signal); }
    finally {
      flight.waiters--;
      if (flight.waiters === 0 && !flight.settled) {
        if (loginFlights.get(key) === flight) loginFlights.delete(key);
        flight.controller.abort();
      }
    }
  }
  if (signal?.aborted || deadline <= Date.now()) throw new UpstreamError('timeout', '服务响应超时');
  return { key, cookie: session.cookie, headers: { Origin: authOrigin, Cookie: session.cookie } };
}

// This helper only authenticates; callers supply the fixed, explicitly allowed business route.
export async function requestAuthenticatedJson(project, credentials, path, {
  request = requestJson, deadline = Date.now() + 5000, signal, method = 'GET', body, retryUnauthorized = false,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    const session = await authenticatedSession(project, credentials, { request, deadline, signal });
    try {
      return await request(project.apiUrl, path, { deadline, signal, method, body, headers: session.headers });
    } catch (error) {
      if (error.code === 'unauthorized' && session.key && loginSessions.get(session.key)?.cookie === session.cookie) loginSessions.delete(session.key);
      if (!(retryUnauthorized && attempt === 0 && error.code === 'unauthorized' && error.statusCode === 401 && credentials?.password)) throw error;
    }
  }
}

export async function readSummary(project, credentials, { request = requestJson, deadline = Date.now() + 5000, signal } = {}) {
  const options = { deadline, signal };
  const authOrigin = project.authOrigin || new URL(project.apiUrl).origin;
  const get = async (path, headers = {}) => {
    if (project.adapter === 'asset' || project.adapter === 'aster') return (await requestAuthenticatedJson(project, credentials, path, { ...options, request })).data;
    return (await request(project.apiUrl, path, { ...options, headers: { Origin: authOrigin, ...headers } })).data;
  };
  const summaryHeaders = credentials?.password && ['standard', 'monitor'].includes(project.adapter) ? { Authorization: `Basic ${Buffer.from(`${credentials.username || ''}:${credentials.password}`).toString('base64')}` } : {};
  const selectedMonitor = project.adapter === 'monitor' ? new URL(project.url || project.apiUrl).searchParams.get('monitor') : null;
  const summaryPath = `/api/hub/summary?schemaVersion=2${selectedMonitor ? `&monitor=${encodeURIComponent(selectedMonitor)}` : ''}`;
  try { return standardSummary(await get(summaryPath, summaryHeaders)); }
  catch (error) { if (![404, 405].includes(error.statusCode)) throw error; }
  if (project.adapter === 'standard') return standardSummary(await get('/api/hub/summary', summaryHeaders));
  if (project.adapter === 'monitor') return readMonitor(project, credentials, get);
  if (project.adapter === 'aster') {
    const data = await get('/api/state?compact=true');
    if (!data || !Array.isArray(data.accounts) || data.accounts.length > 200) throw new UpstreamError('invalid', '交易项目响应格式不正确');
    const accounts = data.accounts.filter(account => account.enabled);
    const live = accounts.filter(account => account.mode === 'live');
    const updatedAt = oldest(live.map(account => iso(account.snapshot?.timestamp)));
    const utcDay = new Date().toISOString().slice(0, 10);
    const volumes = live.map(account => account.cycle_state?.daily_volume?.utc_date === utcDay && account.cycle_state?.report_status?.status === 'ready' ? finite(account.cycle_state.daily_volume.volume) : null);
    const metrics = [metric('accounts', '启用账户', accounts.length, '个'), metric('live_accounts', '实盘账户', live.length, '个'), metric('occupied_margin', '实盘占用保证金', sum(live.map(account => finite(account.snapshot?.occupied_margin))), 'USD1'), metric('daily_volume', '实盘今日成交量', sum(volumes), 'USD1', '上游 UTC 日口径；不计入资产汇总')];
    const reasons = [];
    if (data.error) reasons.push(`交易服务异常：${diagnosticText(data.error, '上游未提供具体原因')}`);
    if (!data.ready) reasons.push('交易服务尚未就绪');
    for (const [index, account] of live.entries()) {
      const label = diagnosticText(account.name || account.id, `实盘账户 ${index + 1}`);
      if (!account.snapshot) reasons.push(`${label}：缺少账户快照`);
      else {
        if (!iso(account.snapshot.timestamp)) reasons.push(`${label}：快照缺少有效更新时间`);
        if (finite(account.snapshot.occupied_margin) === null) reasons.push(`${label}：保证金数据缺失或无效`);
      }
      if (volumes[index] === null) {
        const report = account.cycle_state?.report_status;
        const daily = account.cycle_state?.daily_volume;
        const reason = report?.error ? `成交统计读取失败：${diagnosticText(report.error, '上游未提供具体原因')}`
          : report?.status === 'stale' ? '成交统计已过期'
          : report?.status === 'error' ? '成交统计读取失败，上游未提供具体原因'
          : report?.status !== 'ready' ? '成交统计尚未就绪'
          : daily?.utc_date !== utcDay ? '成交统计缺少当日 UTC 数据'
          : '今日成交量缺失或无效';
        reasons.push(`${label}：${reason}`);
      }
    }
    return { metrics, updatedAt, partial: reasons.length > 0, message: diagnosticMessage(data.demo ? '上游为演示模式；交易数据不计入资产汇总' : '保证金与成交量使用 USD1 口径', reasons) };
  }
  const data = await get('/api/ledger');
  if (!data || !Array.isArray(data.assets) || data.assets.length > 1000 || !Array.isArray(data.history)) throw new UpstreamError('invalid', '资产项目响应格式不正确');
  const total = sum(data.assets.map(asset => finite(asset.value)));
  const withdrawals = data.assets.filter(asset => asset.project?.trim() === '出金').reduce((acc, asset) => acc + (finite(asset.value) || 0), 0);
  const manualAssets = data.assets.filter(asset => asset.mode === 'manual');
  const dynamicAssets = data.assets.filter(asset => asset.mode !== 'manual');
  const staticValuation = data.assets.length > 0 && dynamicAssets.length === 0;
  const manualAt = oldest(manualAssets.map(asset => iso(asset.updatedAt)));
  const updatedAt = staticValuation ? manualAt : oldest(dynamicAssets.map(asset => iso(asset.updatedAt)));
  const unknownMode = dynamicAssets.some(asset => !['market', 'bybit', 'aster'].includes(asset.mode));
  const fxTime = iso(data.fxStatus?.fetchedAt);
  const fxStale = !fxTime || Date.now() - new Date(fxTime).getTime() > 300000 || !!data.fxStatus?.error;
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const byDay = new Map();
  for (const row of data.history.slice(-2000)) if (!row.future && !row.archived && /^\d{4}-\d\d-\d\d$/.test(row.date) && row.date <= today && finite(row.total) !== null) { const existing = byDay.get(row.date); if (!existing || !String(existing.id).startsWith('daily-') || String(row.id).startsWith('daily-')) byDay.set(row.date, row); }
  const trend = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-90).map(row => ({ at: `${row.date}T00:00:00+08:00`, value: Number(row.total) }));
  return { metrics: [metric('ledger_total', '表内总额', total, 'USD', '包含表内出金行；不叠加交易项目账户'), metric('holdings', '当前持有', total === null ? null : total - withdrawals, 'USD'), metric('entries', '资产条目', data.assets.length, '项'), ...(manualAssets.length ? [metric('manual_valuation_at', '手工估值记录', manualAt, undefined, '最早手工估值记录时间；手工行不参与实时过期判断')] : []), metric('fx', '美元兑人民币', finite(data.fx), 'CNY/USD', `汇率日期：${data.fxStatus?.rateDate || '未提供'}`)], updatedAt, trend, ...(staticValuation ? { freshness: 'static' } : {}), partial: unknownMode || (staticValuation && !manualAt) || fxStale || data.dataKind === 'example' || data.assets.some(asset => !!asset.error || finite(asset.value) === null), message: data.dataKind === 'example' ? '上游为示例账本，请先在资产项目配置真实数据' : (staticValuation ? '静态估值账本；更新时间为手工估值记录，不代表实时行情；历史曲线为表内总额，非收益曲线' : '资产账本已读取；更新时间取动态资产最早源时间；历史曲线为表内总额，非收益曲线') + (unknownMode ? '；存在未识别的资产来源，按动态数据校验' : '') + (fxStale ? '；汇率已过期或缺少更新时间' : '') };
}

async function readMonitor(project, credentials, get) {
  const headers = credentials?.password ? { Authorization: `Basic ${Buffer.from(`${credentials.username || ''}:${credentials.password}`).toString('base64')}` } : {};
  const manifest = await get('/api/monitors', headers);
  const entries = Array.isArray(manifest) ? manifest : manifest?.monitors;
  if (!Array.isArray(entries) || entries.length > 100) throw new UpstreamError('invalid', '监控项目清单格式不正确');
  const selected = new URL(project.url || project.apiUrl).searchParams.get('monitor');
  const entry = selected ? entries.find(item => item.id === selected) : entries.find(item => item.id === 'oil') || entries[0];
  if (!entry || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id)) throw new UpstreamError('invalid', '监控项目没有可读取的模块');
  const quote = await get(`/api/monitors/${encodeURIComponent(entry.id)}/quote`, headers);
  return normalizeMonitorQuote(quote, entry, entries.length);
}

export function normalizeMonitorQuote(quote, entry, count) {
  if (!quote || typeof quote !== 'object') throw new UpstreamError('invalid', '监控报价格式不正确');
  const common = { updatedAt: iso(quote.fetchedAt), stale: quote.collection?.stale === true || quote.status === 'snapshot', partial: quote.status === 'partial' || quote.status === 'connecting' || !!quote.collection?.error, message: `${entry.title || entry.id}监控已连接` };
  if (entry.id === 'oil') {
    const brent = finite(quote.brent?.markPx); const wti = finite(quote.wti?.markPx);
    if (brent === null || wti === null) throw new UpstreamError('invalid', '原油报价缺少价格字段');
    const spread = brent > 0 && wti > 0 ? finite((brent - wti) / wti * 100) : null;
    return { ...common, partial: common.partial || spread === null, metrics: [metric('brent', '布伦特原油', brent, 'USDT/桶'), metric('wti', 'WTI 原油', wti, 'USDT/桶'), metric('spread', '布伦特相对 WTI 价差', spread, '%'), metric('modules', '监控模块', count, '个')], message: `${common.message}；Binance 标记价格，价差＝(布伦特 − WTI) ÷ WTI × 100%${spread === null ? '；价格无效，价差暂不可用' : ''}` };
  }
  if (entry.id === 'hynix') return { ...common, metrics: [metric('premium', 'ADR 溢价', finite(quote.premium), '%'), metric('spread', 'ADR 与换算价格差', finite(quote.spread), 'USD'), metric('funding', '资金费率年化', finite(quote.funding?.annualizedRate) === null ? null : Number(quote.funding.annualizedRate) * 100, '%'), metric('modules', '监控模块', count, '个')], partial: common.partial || !!quote.fundingError };
  if (entry.id === 'perpetual') {
    if (!Array.isArray(quote.exchanges) || !Array.isArray(quote.quotes)) throw new UpstreamError('invalid', '永续监控数据格式不正确');
    const active = quote.exchanges.filter(exchange => exchange.status !== 'disabled');
    const last = active.map(exchange => typeof exchange.lastMessageAt === 'number' && Number.isFinite(exchange.lastMessageAt) ? new Date(exchange.lastMessageAt).toISOString() : null);
    return { ...common, updatedAt: oldest(last), partial: !!quote.storageError || active.some(exchange => exchange.status !== 'live'), stale: active.some(exchange => exchange.status === 'stale'), metrics: [metric('exchanges', '启用交易所', active.length, '个'), metric('live_exchanges', '在线交易所', active.filter(exchange => exchange.status === 'live').length, '个'), metric('quotes', '报价合约', quote.quotes.length, '个'), metric('modules', '监控模块', count, '个')], message: '永续合约监控已连接；更新时间取启用交易所最早消息时间' };
  }
  throw new UpstreamError('invalid', '该监控模块尚无摘要适配，请使用标准协议或链接模式');
}
