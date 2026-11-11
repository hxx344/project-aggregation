import { sharesPerUnit } from '../trading-execution-plan.mjs';

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

// Same five contracts and share basis as 价差下单 (src/trading-anthropic.ts); the digest has no
// per-browser share assumption, so it always converts with the page's default 12.7B / 16.7B.
const ANT_SHARES = Object.freeze({ outstanding: '12.7', diluted: '16.7' });
const ANT_CONTRACTS = Object.freeze([
  { exchange: 'hyperliquid', symbol: 'io:ANTH', label: 'HL io:ANTH' }, { exchange: 'hyperliquid', symbol: 'xyz:ANT', label: 'HL xyz:ANT' },
  { exchange: 'binance', symbol: 'ANTHROPICUSDT', label: 'Binance' }, { exchange: 'okx', symbol: 'ANTHROPICUSDT', label: 'OKX' }, { exchange: 'rh-lighter', symbol: 'ANTHROPIC', label: 'Lighter RH' }]);
const ANT_VENUES = { binance: 'Binance', okx: 'OKX', hyperliquid: 'Hyperliquid', 'rh-lighter': 'Lighter RH' };
const SPREAD_COLUMNS = [{ key: 'long', label: '做多' }, { key: 'short', label: '做空' }, { key: 'gap', label: '每股价差', align: 'right' }];
const ANT_POSITION_COLUMNS = [{ key: 'venue', label: '交易所' }, { key: 'symbol', label: '合约' }, { key: 'size', label: '方向 · 数量', align: 'right' }, { key: 'pnl', label: '浮动盈亏', align: 'right' }, { key: 'distance', label: '距强平', align: 'right' }];
const quotePrice = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0 ? Number(value) : null;
const perShareText = value => value === null ? MISSING : value.toFixed(2);
const percentText = value => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
function shareUnit(exchange, symbol, contractSize) {
  try { return Number(sharesPerUnit({ exchange, symbol }, ANT_SHARES, contractSize ?? '1')); } catch { return null; }
}
// One book per contract, read like the page's readBook: a leg older than maxAgeMs before the reply is stale.
function antBook(quotes, contract) {
  const row = quotes.books?.find(book => book.exchange === contract.exchange && book.symbol === contract.symbol);
  if (!row) return { contract, error: '未取得盘口' };
  if (row.error) return { contract, error: String(row.error) };
  const bid = quotePrice(row.bid), ask = quotePrice(row.ask), at = stamp(row.at), generated = stamp(quotes.generatedAt), unit = shareUnit(contract.exchange, contract.symbol);
  if (bid === null || ask === null || bid >= ask || at === null || generated === null || !unit) return { contract, error: '盘口不完整' };
  return { contract, at, bid: bid / unit, ask: ask / unit, stale: generated - at > quotes.maxAgeMs };
}
// Each pair once in its better direction: buy the cheaper leg's ask, sell the dearer leg's bid, percent of the ask.
function antPairs(books) {
  const live = books.filter(book => !book.error), pairs = [];
  live.forEach((first, index) => live.slice(index + 1).forEach(second => {
    const forward = (second.bid - first.ask) / first.ask * 100, backward = (first.bid - second.ask) / second.ask * 100;
    const [long, short, gap] = forward >= backward ? [first, second, forward] : [second, first, backward];
    pairs.push({ long, short, gap, stale: long.stale || short.stale });
  }));
  return pairs.sort((a, b) => b.gap - a.gap);
}
/**
 * ANT 套利: per-share prices and pairwise gaps from the execution quotes (same books as 价差下单),
 * positions from the 套利仓位 watch. Either input may be `{ error }`; the other still shows.
 */
export function anthropicSection({ quotes, watch }) {
  const id = 'hub:anthropic', name = 'ANT 套利', issues = [], times = [];
  let level = 'ok', status = '正常';
  const raise = (next, text) => { const rank = { ok: 0, notice: 1, warn: 2, alert: 3 }; if (rank[next] > rank[level]) { level = next; status = text; } };
  const metrics = [];

  if (quotes.error) { issues.push('ANT 报价读取失败'); raise('warn', '报价读取失败'); }
  else {
    const books = ANT_CONTRACTS.map(contract => antBook(quotes, contract)), failed = books.filter(book => book.error);
    for (const book of books) if (!book.error) times.push(book.at);
    if (failed.length === books.length) { issues.push('ANT 各交易所报价均读取失败'); raise('warn', '报价读取失败'); }
    else if (failed.length) raise('notice', '部分报价缺失');
    if (books.some(book => book.stale)) raise('notice', '部分报价过期');
    const pairs = antPairs(books);
    metrics.push({ key: 'prices', label: '每股价格（买 / 卖，按 127 亿 / 167 亿股折算）', text: `${books.length - failed.length} / ${books.length} 个合约`,
      lines: books.map(book => book.error ? `${book.contract.label}：读取失败 ${clean(redacted(book.error), 60)}` : `${book.contract.label}：${perShareText(book.bid)} / ${perShareText(book.ask)}${book.stale ? '（过期）' : ''}`) });
    metrics.push({ key: 'spreads', label: '两两价差', text: pairs.length ? `${pairs.length} 组` : '无',
      groups: pairs.length ? [{ title: `ANT 每股可成交价差：买入做多腿卖一、卖出做空腿买一（${pairs.length} 组）`, columns: SPREAD_COLUMNS,
        rows: pairs.map(pair => ({ long: pair.long.contract.label, short: pair.short.contract.label, gap: `${percentText(pair.gap)}${pair.stale ? '（过期）' : ''}` })) }] : [] });
  }

  if (watch.error) { issues.push('ANT 仓位读取失败'); raise('warn', '仓位读取失败'); }
  else {
    // Only an enabled 套利仓位 alert raises the digest; otherwise a near row is flagged in the table alone.
    const threshold = numeric(watch.alerts?.config?.thresholdPercent), alertsOn = watch.alerts?.config?.enabled === true, connected = (watch.sources ?? []).filter(source => source.connected);
    for (const source of connected) {
      const venue = ANT_VENUES[source.exchange] ?? source.exchange, fetched = stamp(source.fetchedAt);
      if (source.state !== 'live') { issues.push(`${venue} 仓位：${source.error || (source.state === 'loading' ? '正在读取' : '数据过期')}`); if (source.state !== 'loading') raise('warn', '部分来源异常'); }
      if (fetched !== null && ['live', 'stale'].includes(source.state)) times.push(fetched);
    }
    // Rows kept from a failed or stale read are shown as old and never raise the section on their own.
    const positions = connected.flatMap(source => (source.positions ?? []).map(position => ({ ...position, old: source.state !== 'live' })));
    const loading = connected.some(source => source.state === 'loading');
    // Venues settle in USDT or USDC, so unrealized PnL is totalled per venue and never across them.
    const pnl = new Map();
    let longShares = 0, shortShares = 0, nearest = null;
    const rows = positions.map(position => {
      const venue = `${ANT_VENUES[position.exchange] ?? position.exchange}${position.account === undefined ? '' : ` #${position.account}`}`;
      const unit = shareUnit(position.exchange, position.symbol, position.contractSize), shares = unit === null ? NaN : Number(position.quantity) * unit;
      if (position.side === 'long') longShares += shares; else shortShares += shares;
      const unrealized = numeric(position.unrealizedPnl), venueName = ANT_VENUES[position.exchange] ?? position.exchange, total = pnl.get(venueName) ?? { sum: 0, missing: 0 };
      if (unrealized === null) total.missing++; else total.sum += unrealized;
      pnl.set(venueName, total);
      const distance = position.riskUnknown ? null : numeric(position.distancePercent);
      const near = distance !== null && threshold !== null && distance <= threshold;
      if (distance !== null && (nearest === null || distance < nearest.distance)) nearest = { distance, label: `${venue} ${position.symbol}` };
      if (alertsOn && !position.old && (near || position.alerting)) { issues.push(`${venue} ${position.symbol} ${position.side === 'long' ? '多' : '空'}仓距强平 ${distance === null ? '未知' : `${distance.toFixed(2)}%`}${threshold === null ? '' : `（预警线 ${threshold}%）`}`); raise('alert', '接近强平'); }
      const quantity = `${amount(position.quantity)}${position.quantityUnit ? ` ${position.quantityUnit}` : ''}${Number.isFinite(shares) ? `（≈${digits(shares)} 股）` : ''}`;
      return { venue: clean(venue, 40), symbol: clean(position.symbol, 24), size: `${position.side === 'long' ? '多' : '空'} ${quantity}`, pnl: signed(position.unrealizedPnl), distance: `${distance === null ? '未知' : `${distance.toFixed(2)}%${near ? ' ⚠' : ''}`}${position.old ? '（过期）' : ''}` };
    });
    const sharesKnown = Number.isFinite(longShares) && Number.isFinite(shortShares);
    metrics.push(metric('count', 'ANT 持仓笔数', !connected.length ? '未连接下单账户' : !positions.length && loading ? '读取中' : `${positions.length}`));
    if (positions.length) metrics.push(
      metric('shares', '多空股数（估算）', sharesKnown ? `多 ≈${digits(longShares)} · 空 ≈${digits(shortShares)} · 净 ${signed(longShares - shortShares)} 股` : MISSING),
      metric('pnl', '浮动盈亏（各交易所结算币）', [...pnl].map(([venue, { sum, missing }]) => `${clean(venue, 40)} ${missing && !sum ? MISSING : signed(sum)}${missing ? `（${missing} 笔未计入）` : ''}`).join(' · ')),
      metric('nearest', '最近强平距离', nearest ? `${nearest.distance.toFixed(2)}%（${clean(nearest.label, 60)}）${threshold === null ? ' · 预警线未知' : ` · 预警线 ${threshold}%${alertsOn ? '' : '（预警未开启）'}`}` : MISSING),
      { key: 'positions', label: 'ANT 持仓明细', text: `${positions.length} 项`, groups: [{ title: `ANT 持仓（${positions.length} 笔）`, columns: ANT_POSITION_COLUMNS, rows }] });
  }
  return section(id, name, level, status, { asOf: times.length ? Math.min(...times) : null, issues, metrics });
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
const settle = async (read, part, log) => {
  try { return await read(); } catch (error) { log.warn({ err: error, section: 'hub:anthropic', part, type: 'feishu-digest' }, '飞书汇总读取 ANT 数据失败'); return { error: true }; }
};
export async function collectSections({ overview, positions, funding, execution, anthropic = null, log = console, now = Date.now }) {
  const hub = await Promise.all([
    guarded('hub:positions', '交易所持仓', async () => positionsSection(await positions()), log),
    // Quotes and positions fail separately, so one missing half never hides the other.
    ...(anthropic ? [guarded('hub:anthropic', 'ANT 套利', async () => {
      const [quotes, watch] = await Promise.all([settle(anthropic.quotes, 'quotes', log), settle(anthropic.positions, 'positions', log)]);
      if (quotes.error && watch.error) throw new Error('anthropic_sources_failed');
      return anthropicSection({ quotes, watch });
    }, log)] : []),
    guarded('hub:funding', '原油四腿', () => fundingSection(funding()), log),
    guarded('hub:execution', '原生执行', () => executionSection(execution()), log),
  ]);
  const projects = overview().projects.filter(snapshot => snapshot.project.adapter !== 'link').map(snapshot => projectSection(snapshot, now()));
  return [...hub, ...projects];
}
