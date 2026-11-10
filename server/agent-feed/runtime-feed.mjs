import { SCHEMA_VERSION, dataset, isoOf, row, unavailable } from './catalog.mjs';

// The data plane's share of the agent feed (docs/agent-feed.md): values it
// already holds in memory. Building it starts no exchange, chain or module
// request, and it reads no account, position, balance or credential field:
// each dataset below names the fields it takes, and nothing else is copied.
const PROJECT_CHECK_MAX_AGE_MS = 180_000, LOOP_MAX_AGE_MS = 30_000, AERO_POOLS = 40;
const PROJECT_STATUS = { online: 'ok', disabled: 'ok', partial: 'warn', stale: 'warn', unconfigured: 'warn', offline: 'alert', unauthorized: 'alert' };
const stamp = value => { const at = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
const rounded = value => typeof value === 'number' && Number.isFinite(value) ? Number(value.toPrecision(6)) : null;
const scaled = (value, factor) => typeof value === 'number' && Number.isFinite(value) ? rounded(value * factor) : null;

// State of each summary read, without the metrics or the diagnostic texts: those can carry account figures.
function projects(overview, at) {
  const rows = [];
  for (const item of overview.projects) {
    if (item.project.adapter === 'link') continue;
    const checked = stamp(item.checkedAt), asOf = isoOf(checked ?? at), expiresAt = checked === null ? null : isoOf(checked + PROJECT_CHECK_MAX_AGE_MS);
    const base = { entity: `project:${item.project.id}`, label: item.project.name, asOf, expiresAt };
    rows.push(row({ ...base, metric: 'state', value: item.state, status: PROJECT_STATUS[item.state] ?? 'warn' }));
    if (checked === null) continue;
    const count = Array.isArray(item.diagnostics) ? item.diagnostics.length : 0;
    rows.push(row({ ...base, metric: 'latency', value: item.latencyMs, unit: 'ms' }),
      row({ ...base, metric: 'diagnostics', value: count, status: count ? 'warn' : 'ok' }),
      row({ ...base, metric: 'last_success_at', value: isoOf(stamp(item.lastSuccessAt)), status: 'ok' }));
  }
  return dataset('system.projects', rows, { asOf: isoOf(at) });
}

function eventLoop(lag, at) {
  if (!lag.monitoring) return unavailable('system.event-loop', '卡顿监测未运行');
  const base = { entity: 'runtime', asOf: isoOf(stamp(lag.generatedAt) ?? at), expiresAt: isoOf((stamp(lag.generatedAt) ?? at) + LOOP_MAX_AGE_MS) };
  const level = value => typeof value === 'number' && value >= lag.stallThresholdMs ? 'warn' : 'ok';
  return dataset('system.event-loop', [
    row({ ...base, metric: 'max_lag_1m', value: lag.lastMinute.maxMs, unit: 'ms', status: level(lag.lastMinute.maxMs) }),
    row({ ...base, metric: 'stalls_1m', value: lag.lastMinute.stalls, status: lag.lastMinute.stalls ? 'warn' : 'ok' }),
    row({ ...base, metric: 'max_lag_5m', value: lag.lastFiveMinutes.maxMs, unit: 'ms', status: level(lag.lastFiveMinutes.maxMs) }),
    row({ ...base, metric: 'stalls_5m', value: lag.lastFiveMinutes.stalls, status: lag.lastFiveMinutes.stalls ? 'warn' : 'ok' }),
  ], { asOf: base.asOf });
}

// Monitor's summary metrics are market observations (prices, spreads, premiums,
// funding rates, monitor counts). Other adapters' metrics are account figures and stay out.
function monitor(overview, at) {
  const sources = overview.projects.filter(item => item.project.adapter === 'monitor' && item.project.enabled);
  if (!sources.length) return dataset('market.monitor', [], { message: '没有启用的 Monitor 模块' });
  const rows = [];
  for (const item of sources) {
    const updated = stamp(item.updatedAt), current = ['online', 'partial'].includes(item.state);
    const ttl = Number.isFinite(item.staleAfterSeconds) ? item.staleAfterSeconds * 1000 : null;
    for (const metric of Array.isArray(item.metrics) ? item.metrics : []) {
      if (typeof metric?.key !== 'string' || !['number', 'string', 'boolean'].includes(typeof metric.value)) continue;
      rows.push(row({ entity: `monitor:${item.project.id}`, metric: metric.key, label: metric.label, value: typeof metric.value === 'number' ? rounded(metric.value) : metric.value, unit: metric.unit ?? null,
        asOf: isoOf(updated), expiresAt: updated === null || ttl === null ? null : isoOf(updated + ttl), stale: !current || updated === null }));
    }
  }
  return dataset('market.monitor', rows, { asOf: isoOf(at), message: rows.length ? null : 'Monitor 尚未返回指标' });
}

// The largest pools by TVL across the scanned chains. Favourites, filters and RPC settings are personal configuration and stay out.
function aero(state) {
  if (!state.config.enabled) return dataset('market.aero', [], { message: '行情扫描未开启' });
  const ttl = 2 * state.config.intervalMin * 60_000 + 300_000;
  const times = at => Number.isFinite(at) ? { asOf: isoOf(at), expiresAt: isoOf(at + ttl) } : { asOf: null, expiresAt: null };
  const chains = new Map(state.chains.map(chain => [chain.id, chain]));
  const rows = [row({ entity: 'token:AERO', metric: 'price', label: 'AERO', value: rounded(state.aero?.usd), unit: 'USD', ...times(state.aero?.at) })];
  const largest = state.pools.filter(pool => typeof pool.tvlUsd === 'number' && Number.isFinite(pool.tvlUsd)).sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, AERO_POOLS);
  for (const pool of largest) {
    const chain = chains.get(pool.chain);
    const base = { entity: `pool:${pool.chain}:${pool.address}`, label: `${pool.token0.symbol}/${pool.token1.symbol} · ${chain?.name ?? pool.chain} · 间距 ${pool.tickSpacing}`, ...times(chain?.updatedAt) };
    rows.push(row({ ...base, metric: 'tvl', value: rounded(pool.tvlUsd), unit: 'USD' }),
      row({ ...base, metric: 'fee', value: scaled(pool.fee, 1e-4), unit: '%' }),
      row({ ...base, metric: 'emission', value: scaled(pool.emissionPerSec, 86400), unit: 'AERO/day' }),
      row({ ...base, metric: 'daily_vol_24h', value: scaled(pool.vol24h?.daily, 100), unit: '%' }),
      row({ ...base, metric: 'daily_vol_7d', value: scaled(pool.vol7d?.daily, 100), unit: '%' }));
  }
  const latest = Math.max(...state.chains.map(chain => chain.updatedAt ?? 0));
  return dataset('market.aero', rows, { asOf: latest > 0 ? isoOf(latest) : null, message: largest.length ? null : '尚无池子快照' });
}

// One dataset's failure leaves the others readable; the reason stays in the log.
export function createRuntimeFeed({ readOverview, readEventLoop, readAero, now = Date.now, log }) {
  const guarded = (id, build) => {
    try { return build(); }
    catch (error) { log.warn?.({ err: error, dataset: id, type: 'agent-feed' }, '数据接口的数据集生成失败'); return unavailable(id, '数据集暂时无法生成'); }
  };
  return () => {
    const at = now();
    let overview = null, failure = null;
    try { overview = readOverview(); } catch (error) { failure = error; }
    const fromOverview = (id, build) => overview ? guarded(id, () => build(overview, at)) : guarded(id, () => { throw failure; });
    return { schemaVersion: SCHEMA_VERSION, generatedAt: isoOf(at), datasets: [
      fromOverview('system.projects', projects),
      guarded('system.event-loop', () => eventLoop(readEventLoop(), at)),
      fromOverview('market.monitor', monitor),
      guarded('market.aero', () => aero(readAero())),
    ] };
  };
}
