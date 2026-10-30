// Turns each module's existing read model into one digest section:
// { id, name, level, status, asOf, metrics: [{ key, label, text, lines? }], issues }.
// level: ok / notice / idle stay out of "needs attention"; warn / alert enter it.
// Sections go through each module's own read path and its cache, never place
// or change anything; a missing value stays '—' and never becomes 0.
const ATTENTION_DELAY_MS = 120_000;
const MISSING = '—';
const ISSUE_LIMIT = 6;
const ROW_LIMIT = 12;
const POSITION_COLUMNS = [{ key: 'symbol', label: '合约' }, { key: 'side', label: '方向' }, { key: 'quantity', label: '数量', align: 'right' }, { key: 'pnl', label: '浮动盈亏', align: 'right' }];
const SOURCE_TIMEOUT_MS = 20_000;
const clean = (value, limit = 120) => { const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const stamp = value => { const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) && ms > 0 ? ms : null; };
const numeric = value => { if (value === null || value === undefined || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; };
const digits = value => {
  const size = Math.abs(value);
  return new Intl.NumberFormat('en-US', size >= 1000 ? { maximumFractionDigits: 2 } : size >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 }).format(value);
};
const signed = value => { const number = numeric(value); return number === null ? MISSING : `${number > 0 ? '+' : ''}${digits(number)}`; };
const amount = (value, unit = '') => { const number = numeric(value); return number === null ? MISSING : `${digits(number)}${unit}`; };
const percent = value => { const number = numeric(value); return number === null ? MISSING : `${digits(number * 100)}%`; };
const metric = (key, label, text) => ({ key, label, text });
const rows = (key, label, lines, total = lines.length) => ({ key, label, text: total ? `${total} 项` : '无', lines: total > lines.length ? [...lines, `其余 ${total - lines.length} 项请到工作台查看`] : lines });
// Upstream error text can quote a request URL, and a group chat is a wider audience than the workbench.
const redacted = text => String(text).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[地址已隐藏]');
const section = (id, name, level, status, { asOf = null, metrics = [], issues = [] } = {}) => ({ id, name: clean(name, 60), level, status: clean(status, 40), asOf, metrics, issues: issues.slice(0, ISSUE_LIMIT).map(issue => clean(redacted(issue))) });

function metricText({ value, unit }) {
  if (value === null || value === undefined) return MISSING;
  const text = typeof value === 'number' ? digits(value) : clean(value, 160);
  return !unit ? text : unit === '%' ? `${text}%` : `${text} ${clean(unit, 24)}`;
}
const PROJECT_STATES = { online: '正常', partial: '部分异常', stale: '数据过期', offline: '离线', unauthorized: '需要登录', unconfigured: '未配置', disabled: '已停用' };
// Same rule as the overview page: faults wait 120 seconds, so a passing blip stays out of the digest.
export function projectSection(snapshot, now) {
  const { project, state, diagnostics } = snapshot, id = `project:${project.id}`, status = PROJECT_STATES[state] ?? state;
  if (state === 'disabled' || state === 'unconfigured') return section(id, project.name, 'idle', status);
  const raw = diagnostics ?? (state === 'online' ? [] : [{ id: 'hub:legacy-health', kind: state === 'unauthorized' ? 'action' : 'fault', message: snapshot.message || '项目状态异常，请进入项目查看', firstSeenAt: '' }]);
  const actions = raw.filter(issue => issue.kind === 'action');
  const faults = raw.filter(issue => issue.kind === 'fault' && (diagnostics === undefined || now - Date.parse(issue.firstSeenAt) >= ATTENTION_DELAY_MS));
  const level = actions.length || (faults.length && ['offline', 'unauthorized'].includes(state)) ? 'alert' : faults.length ? 'warn' : state === 'online' ? 'ok' : 'notice';
  return section(id, project.name, level, status, { asOf: stamp(snapshot.updatedAt), issues: [...actions, ...faults].map(issue => issue.message),
    metrics: (snapshot.metrics ?? []).map(item => metric(item.key, clean(item.label, 80), metricText(item))) });
}

const add = (totals, currency, value) => totals.set(currency, (totals.get(currency) ?? 0) + value);
const perCurrency = (totals, missing) => totals.size || !missing ? `${[...totals].map(([currency, value]) => `${signed(value)} ${currency}`).join(' / ') || '0'}${missing ? `（${missing} 笔未计入）` : ''}` : MISSING;
export function positionsSection(data) {
  const id = 'hub:positions', name = '交易所持仓', sources = (data.sources ?? []).filter(source => source.status !== 'unconfigured');
  if (!sources.length) return section(id, name, 'idle', '未接入 Asset');
  const issues = [], items = [], pnl = new Map(), net = new Map();
  let oldest = null, partial = false, pnlMissing = 0, netMissing = 0;
  for (const source of sources) {
    if (source.error) { issues.push(`${source.name}：${source.error}`); partial = true; }
    for (const exchange of source.data?.exchanges ?? []) for (const account of exchange.accounts) for (const scope of account.scopes) {
      if (scope.status === 'error' || scope.status === 'stale') { issues.push(`${exchange.name} ${scope.label}：${scope.error || '数据过期'}`); partial = true; }
      const fetched = stamp(scope.fetchedAt);
      if (['live', 'stale'].includes(scope.status) && fetched !== null) oldest = oldest === null ? fetched : Math.min(oldest, fetched);
      for (const position of scope.positions) {
        const unrealized = numeric(position.unrealizedPnl), cycle = position.cycle?.status === 'complete' ? numeric(position.cycle.net) : null;
        if (unrealized === null || !position.pnlCurrency) pnlMissing++; else add(pnl, position.pnlCurrency, unrealized);
        if (cycle === null || !position.cycle?.currency) netMissing++; else add(net, position.cycle.currency, cycle);
        items.push({ exchange: exchange.name, size: Math.abs(numeric(position.notional) ?? 0), row: { symbol: `${position.symbol}`, side: position.side === 'long' ? '多' : '空', quantity: `${amount(position.quantity)}${position.quantityUnit ? ` ${position.quantityUnit}` : ''}`, pnl: `${signed(position.unrealizedPnl)}${position.pnlCurrency ? ` ${position.pnlCurrency}` : ''}` } });
      }
    }
  }
  items.sort((a, b) => b.size - a.size);
  const byExchange = new Map();
  for (const item of items) byExchange.set(item.exchange, [...(byExchange.get(item.exchange) ?? []), item.row]);
  const groups = [...byExchange].sort(([a], [b]) => a.localeCompare(b)).map(([exchange, rows]) => ({ title: `${clean(exchange, 60)}（${rows.length} 笔）`, columns: POSITION_COLUMNS, rows }));
  const note = partial ? '（来源不完整）' : '';
  return section(id, name, issues.length ? 'warn' : 'ok', issues.length ? '部分来源异常' : '正常', { asOf: oldest, issues, metrics: [
    metric('count', '持仓笔数', `${items.length}${note}`), metric('pnl', '浮动盈亏', `${perCurrency(pnl, pnlMissing)}${note}`), metric('cycleNet', '本轮净收益', `${perCurrency(net, netMissing)}${note}`),
    { key: 'positions', label: '持仓明细', text: items.length ? `${items.length} 项` : '无', groups }] });
}

export function fundingSection(state) {
  const id = 'hub:funding', name = state.strategy?.name ?? '原油四腿', accounts = state.accounts.filter(account => state.exchanges.includes(account.exchange));
  if (!accounts.some(account => account.connected)) return section(id, name, 'idle', '未连接账户');
  const issues = accounts.filter(account => !account.connected).map(account => `${account.name}：未连接`);
  for (const account of accounts.filter(item => item.connected)) {
    if (account.positions.state !== 'live') issues.push(`${account.name} 持仓：${account.positions.error || '数据过期'}`);
    if (account.funding.state !== 'live') issues.push(`${account.name} 资金费：${account.funding.error || '数据过期'}`);
  }
  const latest = state.pnl?.latest ?? null, currency = state.funding.currency ?? 'USDT';
  return section(id, name, issues.length ? 'warn' : 'ok', issues.length ? '部分来源异常' : '正常', { asOf: state.pnl?.status === 'incomplete' ? null : stamp(latest?.time), issues, metrics: [
    metric('funding7d', '近 7 天资金费净额', `${signed(state.funding.net)} ${currency}${state.funding.complete ? '' : '（不完整）'}`),
    metric('unrealized', '未实现盈亏', `${signed(latest?.unrealizedPnl)} ${currency}`), metric('total', '累计盈亏', `${signed(latest?.totalPnl)} ${currency}`)] });
}

const JOB_STATUS = { queued: '排队中', running: '执行中', stopping: '正在停止', attention: '需要处理', paused: '已暂停' };
const MARKETS = { oil: '原油', hynix: '海力士' };
export function executionSection(state) {
  const id = 'hub:execution', name = '原生执行', connected = state.connections.filter(item => item.connected).length;
  const active = state.jobs.filter(job => !['completed', 'stopped'].includes(job.status));
  if (!connected && !active.length) return section(id, name, 'idle', '未连接账户');
  const label = job => `${MARKETS[job.market] ?? job.market} ${job.action} · ${JOB_STATUS[job.status] ?? job.status} · 批次 ${job.batchIndex}/${job.batchCount}`;
  const stuck = active.filter(job => ['attention', 'paused'].includes(job.status));
  const fetched = state.positions.map(position => stamp(position.fetchedAt)).filter(value => value !== null);
  return section(id, name, active.some(job => job.status === 'attention') ? 'alert' : stuck.length ? 'warn' : 'ok', stuck.length ? '任务需要关注' : active.length ? '任务运行中' : '正常', {
    asOf: fetched.length ? Math.min(...fetched) : null, issues: stuck.map(job => `${label(job)}${job.reason ? `：${job.reason}` : ''}`), metrics: [
      metric('accounts', '已连接账户', `${connected} / ${state.connections.length}`), metric('positions', '账户持仓', `${state.positions.length} 笔`),
      rows('jobs', '进行中任务', active.slice(0, ROW_LIMIT).map(label), active.length)] });
}

const AERO_STATES = { starting: '正在启动', running: '运行中', stopping: '正在停止', stopped: '已停止', fault: '异常' };
const RANGE = { in: '区间内', below: '低于下沿', above: '高于上沿' };
export function aeroSection(state, now) {
  const id = 'hub:aero-lp', name = 'Aero LP', status = state.paused ? '暂停执行' : AERO_STATES[state.state] ?? state.state;
  if (!state.enabled && state.state === 'stopped') return section(id, name, 'idle', status);
  const cycle = state.lastCycle, live = cycle?.positions.filter(position => position.liquidity !== '0') ?? [];
  const position = live.find(item => item.staked) ?? live[0], rewards = cycle?.rewards, quote = cycle?.symbols?.[1] ?? '';
  const asOf = stamp(cycle?.at), limit = Math.max(600, (state.config?.intervalSec ?? 60) * 3) * 1000;
  const late = state.state === 'running' && !state.paused && asOf !== null && now - asOf > limit;
  const issues = [...(state.error ? [state.error] : []), ...(late ? ['最近一轮检查已过期'] : [])];
  const level = state.state === 'fault' ? 'alert' : issues.length ? 'warn' : state.state === 'running' && !state.paused ? 'ok' : 'notice';
  const total = rewards?.dailyTotal;
  const daily = amount(total?.perDay);
  const dailyBasis = total?.scenario === 'same-lower' ? '（同下沿估计，假设其他活跃流动性不变）'
    : ['different-lower', 'mixed-ranges'].includes(total?.reason) ? '（逐仓独立估计，不合计）' : '';
  return section(id, name, level, status, { asOf, issues, metrics: [
    metric('price', '现价', cycle ? `${amount(cycle.price)} ${quote}`.trim() : MISSING), metric('range', '头寸位置', position ? RANGE[position.state] ?? MISSING : '暂无头寸'),
    metric('value', '头寸价值', typeof position?.value === 'number' ? `${amount(position.value)} ${quote}`.trim() : MISSING), metric('apr', 'AERO 年化', percent(position?.apr)),
    metric('aeroPerDay', '预估每日 AERO', `${daily}${dailyBasis}`), metric('feeApr', '手续费年化（不质押）', percent(position?.feeApr)),
    metric('pending', '待领取 AERO', amount(rewards?.pending)), metric('reward', '累计领取 AERO', amount(state.ledger?.reward)), metric('gas', '累计 Gas', state.ledger ? `${amount(state.ledger.gasEth)} ETH` : MISSING)] });
}

const LAB_STATES = { starting: '正在启动', running: '运行中', stopped: '已停止', fault: '异常' };
export function researchSection(state) {
  const id = 'hub:research', name = 'Entropy / Lighter', status = LAB_STATES[state.state] ?? state.state;
  if (!state.enabled && state.state === 'stopped') return section(id, name, 'idle', status);
  const late = state.state === 'running' && state.stale;
  const issues = [...(state.error ? [state.error] : []), ...(late ? ['研究报告已过期'] : [])];
  const insights = state.insights;
  return section(id, name, state.state === 'fault' ? 'alert' : issues.length ? 'warn' : state.state === 'running' ? 'ok' : 'notice', status, { asOf: stamp(insights?.asOf), issues, metrics: [
    metric('summary', '结论', insights?.summary?.title ? clean(insights.summary.title, 160) : MISSING), metric('leader', '领先方向', insights?.leader?.title ? clean(insights.leader.title, 160) : MISSING),
    metric('samples', '样本数', amount(insights?.leader?.samples))] });
}

// A source that stays silent only loses its own section; the digest still goes out.
function guarded(id, name, read, log) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('digest_source_timeout')), SOURCE_TIMEOUT_MS); timer.unref?.(); });
  return Promise.race([Promise.resolve().then(read), timeout]).catch(error => {
    log.warn({ err: error, section: id, type: 'feishu-digest' }, '飞书汇总读取模块失败');
    return section(id, name, 'warn', '读取失败', { issues: ['本次读取失败，请到工作台查看'] });
  }).finally(() => clearTimeout(timer));
}
export async function collectSections({ overview, positions, funding, execution, aero, research, log = console, now = Date.now }) {
  const hub = await Promise.all([
    guarded('hub:positions', '交易所持仓', async () => positionsSection(await positions()), log),
    guarded('hub:funding', '原油四腿', () => fundingSection(funding()), log),
    guarded('hub:execution', '原生执行', () => executionSection(execution()), log),
    guarded('hub:aero-lp', 'Aero LP', () => aeroSection(aero(), now()), log),
    guarded('hub:research', 'Entropy / Lighter', () => researchSection(research()), log),
  ]);
  const projects = overview().projects.filter(snapshot => snapshot.project.adapter !== 'link').map(snapshot => projectSection(snapshot, now()));
  return [...hub, ...projects];
}
