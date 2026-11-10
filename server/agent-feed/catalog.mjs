// The agent data feed's datasets and row contract (docs/agent-feed.md). Both
// processes build rows with row(); the API copies every row it serves through
// cleanDataset(), so a field that is not in the contract cannot leave it.
export const SCHEMA_VERSION = 1;
export const MAX_ROWS = 400;
export const ROW_STATUSES = Object.freeze(['ok', 'warn', 'alert', 'unknown']);

// origin 'api': read by the control plane itself, so it still answers while the
// data plane is down. origin 'runtime': collected in the data plane's memory.
// metrics null: the source names its own metrics, and each row carries label and unit.
export const DATASETS = Object.freeze([
  { id: 'system.host', scope: 'system', origin: 'api', title: '服务器负载', refreshSeconds: 5,
    description: '工作台所在服务器的 CPU、内存、交换分区、磁盘与运行时间。entity 为 host 或 disk:<标识>。',
    metrics: { cpu_usage: '%', load_1m: null, load_5m: null, load_15m: null, memory_used: '%', swap_used: '%', disk_used: '%', disk_available: 'bytes', uptime: 's' } },
  { id: 'system.runtime', scope: 'system', origin: 'api', title: '数据面与内嵌模块进程', refreshSeconds: 5,
    description: '数据面是否就绪，以及各内嵌模块进程的状态。entity 为 runtime 或 module:<模块>。state 取值 starting/ready/backoff/draining/fault/stopping/stopped。',
    metrics: { ready: null, state: null, restart_count: null, consecutive_failures: null } },
  { id: 'system.projects', scope: 'system', origin: 'runtime', title: '各模块数据读取状态', refreshSeconds: 30,
    description: '工作台读取各模块摘要的结果。entity 为 project:<模块>。state 取值 online/partial/stale/offline/unauthorized/unconfigured/disabled；diagnostics 是当前诊断条数。不含指标数值与诊断原文。',
    metrics: { state: null, latency: 'ms', diagnostics: null, last_success_at: null } },
  { id: 'system.event-loop', scope: 'system', origin: 'runtime', title: '数据面卡顿', refreshSeconds: 5,
    description: '数据面事件循环延迟。卡顿期间行情与请求都要排队。entity 为 runtime。',
    metrics: { max_lag_1m: 'ms', stalls_1m: null, max_lag_5m: 'ms', stalls_5m: null } },
  { id: 'market.monitor', scope: 'public', origin: 'runtime', title: 'Monitor 行情指标', refreshSeconds: 30,
    description: 'Market Monitor 的摘要指标：原油价格与价差、海力士溢价与资金费率、Anthropic 各所溢价等，取决于 Monitor 当前配置的监控。entity 为 monitor:<模块>，metric、label 与 unit 由 Monitor 给出。',
    metrics: null },
  { id: 'market.aero', scope: 'public', origin: 'runtime', title: 'Aero 池子行情', refreshSeconds: 900,
    description: 'AERO 价格与各链 TVL 最高的池子。entity 为 token:AERO 或 pool:<链>:<池地址>，label 是交易对与 tick 间距。fee 是池子手续费率；emission 是每天排放的 AERO 数量；daily_vol 是小时对数收益折算到 1 天的波动率。不含年化：年化取决于所选价格区间。',
    metrics: { price: 'USD', tvl: 'USD', fee: '%', emission: 'AERO/day', daily_vol_24h: '%', daily_vol_7d: '%' } },
]);
export const datasetById = id => DATASETS.find(item => item.id === id) ?? null;

const CONTROL = /[\u0000-\u001f\u007f]+/g;
const text = (value, max) => typeof value === 'string' ? value.replace(CONTROL, ' ').trim().slice(0, max) : '';
const iso = value => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
export const isoOf = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null;

// asOf: when the source observed the value. expiresAt: when it stops being
// current; null means only `stale` (the source's own verdict) decides.
// A missing value is null, never 0, and its status is 'unknown'.
export function row({ entity, metric, label = null, value = null, unit = null, asOf = null, expiresAt = null, stale = false, status = null }) {
  const known = value !== null && value !== undefined && !(typeof value === 'number' && !Number.isFinite(value));
  return { entity, metric, label, value: known ? value : null, unit, asOf, expiresAt, stale: !!stale, status: !known ? 'unknown' : status ?? 'ok' };
}
export const dataset = (id, rows, { asOf = null, message = null } = {}) => ({ id, status: 'ok', message, asOf, rows });
export const unavailable = (id, message) => ({ id, status: 'unavailable', message, asOf: null, rows: [] });

function cleanRow(item) {
  if (item === null || typeof item !== 'object') throw new Error('row');
  const entity = text(item.entity, 160), metric = typeof item.metric === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(item.metric) ? item.metric : '';
  const value = item.value;
  if (!entity || !metric || !ROW_STATUSES.includes(item.status) || typeof item.stale !== 'boolean') throw new Error('row');
  if (!(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 200)) throw new Error('row');
  return { entity, metric, label: text(item.label, 120) || null, value: typeof value === 'string' ? text(value, 200) : value, unit: text(item.unit, 24) || null,
    asOf: iso(item.asOf), expiresAt: iso(item.expiresAt), stale: item.stale, status: item.status };
}
// A fresh copy limited to the contract; anything else in `value` is dropped, and a malformed dataset is unavailable as a whole.
export function cleanDataset(value, id) {
  try {
    if (value === null || typeof value !== 'object' || value.id !== id || !['ok', 'unavailable'].includes(value.status) || !Array.isArray(value.rows) || value.rows.length > MAX_ROWS) throw new Error('dataset');
    return { id, status: value.status, message: text(value.message, 200) || null, asOf: iso(value.asOf), rows: value.status === 'ok' ? value.rows.map(cleanRow) : [] };
  } catch { return unavailable(id, '数据格式无效，已丢弃'); }
}
