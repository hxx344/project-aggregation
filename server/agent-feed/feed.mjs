import { HttpError } from '../http-common.mjs';
import { DATASETS, SCHEMA_VERSION, cleanDataset, dataset, datasetById, isoOf, row, unavailable } from './catalog.mjs';

// The control plane's side of the agent feed (docs/agent-feed.md): its own
// datasets, the data plane's, and the snapshot every token reads. One snapshot
// is built at most every CACHE_MS and shared, so the number of agents does not
// change the load on the data plane. Row times stay the sources' own; whether
// a row is stale is decided when it is served, not when it was cached.
export const CACHE_MS = 5000;
const LOCAL_MAX_AGE_MS = 30_000;
const MODULE_STATUS = { ready: 'ok', starting: 'warn', draining: 'warn', stopping: 'warn', stopped: 'warn', backoff: 'alert', fault: 'alert' };
const ROW_FIELDS = Object.freeze({
  entity: '数据所属对象，例如 host、module:monitor、pool:base:0x…',
  metric: '指标标识，同一数据集内含义固定',
  label: '人读名称，可能为 null',
  value: '数值、文本或布尔值；读不到时为 null，不代表 0',
  unit: '单位，无单位时为 null',
  asOf: '来源采到该值的时间（ISO 8601，UTC）',
  stale: 'true 表示该值已超过有效期或来源自报过期，不应当作当前值',
  status: 'ok / warn / alert / unknown；unknown 表示没有值',
});

export function createAgentFeed({ hostStatus, supervisor, runtime, now = Date.now, cacheMs = CACHE_MS, log }) {
  async function host() {
    const status = await hostStatus.read(), at = Date.parse(status.generatedAt);
    const base = { entity: 'host', asOf: status.generatedAt, expiresAt: isoOf(at + LOCAL_MAX_AGE_MS) };
    const level = value => typeof value !== 'number' ? null : value >= 95 ? 'alert' : value >= 85 ? 'warn' : 'ok';
    const rows = [
      row({ ...base, metric: 'cpu_usage', value: status.cpu.usagePercent, status: level(status.cpu.usagePercent) }),
      ...['load_1m', 'load_5m', 'load_15m'].map((metric, index) => row({ ...base, metric, value: status.cpu.loadAverage[index] })),
      row({ ...base, metric: 'memory_used', value: status.memory.usedPercent, status: level(status.memory.usedPercent) }),
      ...(status.memory.swap?.totalBytes ? [row({ ...base, metric: 'swap_used', value: status.memory.swap.usedPercent })] : []),
      row({ ...base, metric: 'uptime', value: status.uptimeSeconds }),
      ...status.disks.flatMap(disk => [
        row({ ...base, entity: `disk:${disk.id}`, label: disk.label, metric: 'disk_used', value: disk.error ? null : disk.usedPercent, status: level(disk.usedPercent) }),
        row({ ...base, entity: `disk:${disk.id}`, label: disk.label, metric: 'disk_available', value: disk.error ? null : disk.availableBytes }),
      ]),
    ];
    return dataset('system.host', rows, { asOf: status.generatedAt });
  }
  // An unreachable runtime is itself the reading: ready=false, alert.
  async function runtimeState() {
    const at = now(), base = { asOf: isoOf(at), expiresAt: isoOf(at + LOCAL_MAX_AGE_MS) };
    let status;
    try { status = await supervisor.status(); }
    catch { return dataset('system.runtime', [row({ ...base, entity: 'runtime', metric: 'ready', value: false, status: 'alert' })], { asOf: base.asOf, message: '数据面没有应答' }); }
    return dataset('system.runtime', [
      row({ ...base, entity: 'runtime', metric: 'ready', value: status.ready, status: status.ready ? 'ok' : 'alert' }),
      ...status.modules.flatMap(item => {
        const module = { ...base, entity: `module:${item.moduleId}` };
        return [row({ ...module, metric: 'state', value: item.state, status: MODULE_STATUS[item.state] ?? 'warn' }),
          row({ ...module, metric: 'restart_count', value: item.restartCount }),
          row({ ...module, metric: 'consecutive_failures', value: item.consecutiveFailures, status: item.consecutiveFailures ? 'warn' : 'ok' })];
      }),
    ], { asOf: base.asOf });
  }
  const local = { 'system.host': host, 'system.runtime': runtimeState };
  async function build() {
    // A runtime of an earlier release answers 404: it is up, and provides none of the datasets.
    const remote = runtime.agentFeed().then(value => new Map((Array.isArray(value?.datasets) ? value.datasets : []).map(item => [item?.id, item])), error => {
      if (error?.status === 404 && error?.origin === 'runtime') return new Map();
      log.warn?.({ err: error, type: 'agent-feed' }, '数据接口未能读取数据面');
      return null;
    });
    const parts = await Promise.all(DATASETS.map(async definition => {
      if (definition.origin === 'api') {
        try { return cleanDataset(await local[definition.id](), definition.id); }
        catch (error) { log.warn?.({ err: error, dataset: definition.id, type: 'agent-feed' }, '数据接口的数据集生成失败'); return unavailable(definition.id, '数据集暂时无法生成'); }
      }
      const datasets = await remote;
      if (!datasets) return unavailable(definition.id, '数据面暂时不可用');
      return datasets.has(definition.id) ? cleanDataset(datasets.get(definition.id), definition.id) : unavailable(definition.id, '数据面当前版本不提供该数据集');
    }));
    return new Map(parts.map(item => [item.id, item]));
  }
  let cached = null, pending = null;
  function current() {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    return pending ??= build().then(value => { cached = { at: now(), value }; return value; }).finally(() => { pending = null; });
  }
  // The catalog's unit applies where a row gives none; expiresAt is internal.
  function present(definition, value, at) {
    let staleRows = 0;
    const rows = value.rows.map(item => {
      const expired = item.value !== null && (item.asOf === null || item.expiresAt !== null && at >= Date.parse(item.expiresAt));
      const stale = item.stale || expired; if (stale) staleRows += 1;
      return { entity: item.entity, metric: item.metric, label: item.label, value: item.value, unit: item.unit ?? definition.metrics?.[item.metric] ?? null, asOf: item.asOf, stale, status: item.status };
    });
    return { id: definition.id, scope: definition.scope, status: value.status, message: value.message, asOf: value.asOf, staleRows, rows };
  }
  const allowed = scopes => DATASETS.filter(item => scopes.includes(item.scope));
  return {
    catalog(scopes) {
      return { schemaVersion: SCHEMA_VERSION, snapshotIntervalSeconds: cacheMs / 1000, rowFields: ROW_FIELDS,
        datasets: allowed(scopes).map(item => ({ id: item.id, scope: item.scope, title: item.title, description: item.description, refreshSeconds: item.refreshSeconds,
          metrics: item.metrics ? Object.entries(item.metrics).map(([metric, unit]) => ({ metric, unit })) : null })) };
    },
    // `wanted` null reads every dataset the token may read.
    async snapshot(scopes, wanted) {
      let selected = allowed(scopes);
      if (wanted !== null) {
        if (!wanted.length || wanted.length > DATASETS.length || new Set(wanted).size !== wanted.length) throw new HttpError(400, 'datasets 参数无效：用逗号分隔数据集标识，不能重复');
        selected = wanted.map(id => {
          const definition = datasetById(id);
          if (!definition) throw new HttpError(400, '数据集不存在，请先读取 /api/agent/v1/catalog');
          if (!scopes.includes(definition.scope)) throw new HttpError(403, `令牌没有 ${definition.scope} 范围，不能读取 ${definition.id}`);
          return definition;
        });
      }
      const values = await current(), at = now();
      return { schemaVersion: SCHEMA_VERSION, generatedAt: isoOf(at), datasets: selected.map(definition => present(definition, values.get(definition.id), at)) };
    },
  };
}
