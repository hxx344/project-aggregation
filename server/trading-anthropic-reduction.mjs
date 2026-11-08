import { ExecutionError, WaitError, StaleMarketError, ExternalOrdersError, exactKeys } from './trading-execution-plan.mjs';
import { normalizeReductionConfig } from './trading-reduction-plan.mjs';
import { immediate } from './control/schema.mjs';

const FINAL = new Set(['completed', 'stopped']);
const iso = time => new Date(time).toISOString();
const initialState = () => ({ phase: 'disabled', jobId: null, reason: null, triggeredAt: null, events: [], failures: 0, retryAt: null });
class ChangedError extends ExecutionError {}

/** One explicitly chosen ANT pair. Reads never trigger work; only the leader's bounded tick can do so. */
export function createAnthropicReduction({ db, execution, admit = operation => operation(), readMaintenance = () => false, now = Date.now, intervalMs = 15_000, log = console } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS execution_anthropic_reduction (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, json TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO execution_anthropic_reduction(id,revision,json) VALUES (1,0,?)').run(JSON.stringify({ config: null, accounts: null, state: initialState() }));
  let closed = false, ticking = null, live = null;
  function record() {
    const row = db.prepare('SELECT revision,json FROM execution_anthropic_reduction WHERE id=1').get();
    try {
      const value = JSON.parse(row.json);
      if (!value.state || !Array.isArray(value.state.events)) throw new Error();
      if (value.config) value.config = normalizeReductionConfig(value.config);
      return { ...value, revision: row.revision };
    } catch { throw new ExecutionError(503, '自动减仓记录无法读取，请恢复记录后再操作'); }
  }
  function write(value) {
    const { revision, ...json } = value;
    const result = db.prepare('UPDATE execution_anthropic_reduction SET revision=revision+1,json=? WHERE id=1 AND revision=?').run(JSON.stringify(json), revision);
    if (!result.changes) throw new ChangedError(409, '自动减仓设置已变化，请刷新后重试');
  }
  const event = (value, message) => { value.state.events = [...value.state.events, { time: iso(now()), message }].slice(-30); };
  const checkRevision = (value, revision) => { if (!Number.isSafeInteger(revision) || revision !== value.revision) throw new ChangedError(409, '自动减仓设置已变化，请刷新后重试'); };
  const associated = value => value.state.jobId ? execution.jobView(value.state.jobId) : null;
  const connections = () => execution.state().connections;
  function accountBindings(config) {
    const all = connections(), bindings = {};
    for (const leg of config.legs) {
      const item = all.find(row => row.exchange === leg.exchange);
      if (!item?.connected || !item.identity) throw new ExecutionError(409, `${leg.exchange} 尚未连接并核验实盘账户`);
      bindings[leg.exchange] = { revision: item.revision, identity: item.identity };
    }
    return bindings;
  }
  function checkBindings(value) {
    const current = accountBindings(value.config);
    for (const [exchange, binding] of Object.entries(current)) if (value.accounts?.[exchange]?.revision !== binding.revision || value.accounts?.[exchange]?.identity !== binding.identity) throw new ExecutionError(409, `${exchange} 实盘连接已变化，自动减仓已停用；请重新核验并启用`);
  }
  function state() {
    const value = record();
    return { generatedAt: iso(now()), revision: value.revision, config: value.config, state: value.state, live, connections: connections(), maintenance: !!readMaintenance(), job: associated(value) };
  }
  function save(body) {
    exactKeys(body, ['revision', 'config', 'confirmLive']);
    const config = normalizeReductionConfig(body.config);
    if (config.enabled && body.confirmLive !== true) throw new ExecutionError(400, '启用前请确认会按规则自动实盘减仓');
    immediate(db, () => {
      const value = record(); checkRevision(value, body.revision);
      const job = associated(value);
      if (job && !FINAL.has(job.status)) throw new ExecutionError(409, '关联减仓任务尚未结束，请先在执行进度核对并停止后再修改');
      if (config.enabled && readMaintenance()) throw new ExecutionError(409, '系统正在维护，暂不能启用自动减仓');
      if (config.enabled && execution.lockOwner(config.legs)) throw new ExecutionError(409, '所选合约已有未结束任务，请先核对');
      const next = { revision: value.revision, config, accounts: config.enabled ? accountBindings(config) : null, state: { ...initialState(), events: value.state.events, phase: config.enabled ? 'armed' : 'disabled',
        reason: config.enabled ? '等待核验当前持仓、减仓数量和分批限制；核验通过后才可触发' : null } };
      event(next, config.enabled ? `已绑定当前实盘账户；${next.state.reason}；本轮完成后自动停用` : '设置已保存，自动减仓未启用'); write(next);
    });
    live = null; return state();
  }
  function disable(body) {
    exactKeys(body, ['revision']);
    immediate(db, () => {
      const value = record(); checkRevision(value, body.revision);
      if (value.config) value.config.enabled = false;
      if (value.state.phase === 'armed') value.state.phase = 'disabled';
      event(value, value.state.phase === 'reducing' ? '已关闭新触发；当前分批任务继续，可在执行进度中停止' : '自动减仓已停用'); write(value);
    });
    return state();
  }
  function settle(value) {
    const job = associated(value);
    if (!job || ['queued', 'running', 'stopping'].includes(job.status)) return false;
    const phase = job.status === 'completed' ? 'completed' : 'review';
    if (value.state.phase === phase && !value.config.enabled) return true;
    value.config.enabled = false; value.state.phase = phase;
    value.state.reason = job.status === 'completed' ? '本轮分批减仓已完成，规则已停用；如需下一轮请重新启用' : `减仓任务${job.reason ? '：' + job.reason : '需人工核对'}；规则已停用，请在执行进度处理原任务`;
    event(value, value.state.reason); write(value); return true;
  }
  async function run() {
    if (closed || !execution.leading()) return;
    let value = record();
    if (value.state.jobId) {
      immediate(db, () => { if (!closed && execution.leading()) settle(record()); });
      return;
    }
    if (!value.config?.enabled || value.state.phase !== 'armed' || readMaintenance()) return;
    if (value.state.retryAt && now() < Date.parse(value.state.retryAt)) return;
    const revision = value.revision;
    const check = () => {
      if (closed || readMaintenance() || !execution.leading()) throw new ChangedError(409, '自动减仓已暂停');
      const latest = record();
      if (latest.revision !== revision || !latest.config?.enabled || latest.state.phase !== 'armed') throw new ChangedError(409, '自动减仓设置已变化');
      checkBindings(latest);
    };
    try {
      check();
      const result = await admit(() => execution.startRiskReduction(value.config, { ruleId: 'anthropic-reduction', accounts: value.accounts, check, commit: (jobId, reading) => {
        check();
        const latest = record();
        latest.state = { ...latest.state, phase: 'reducing', jobId, triggeredAt: iso(now()), reason: null, failures: 0, retryAt: null };
        event(latest, `任一腿距强平 ≤ ${latest.config.thresholdPercent}%，触发双边总计 ${latest.config.reducePercent}% 分批市价减仓`);
        write(latest); live = reading;
      } }));
      if (!result.jobId) {
        immediate(db, () => {
          check(); live = result.live;
          const latest = record();
          if (latest.state.reason || latest.state.failures) { latest.state.reason = null; latest.state.failures = 0; latest.state.retryAt = null; write(latest); }
        });
      }
    } catch (error) {
      if (closed || error instanceof ChangedError) return;
      // The lease and rule revision are checked under the same SQLite write
      // lock as the update; a former process cannot modify its successor's rule.
      immediate(db, () => {
        if (closed || !execution.leading()) return;
        value = record();
        if (value.revision !== revision || !value.config?.enabled || value.state.jobId) return;
        // A trigger held by the owner's orders keeps its risk reading visible.
        live = error instanceof ExternalOrdersError && error.reading ? error.reading : null;
        const message = error instanceof ExecutionError ? error.message : '自动减仓读取或记录失败，本轮没有新建任务';
        const previous = value.state.reason;
        value.state.reason = message;
        if (error instanceof WaitError) { value.state.retryAt = iso(now() + 30_000); }
        else if (error instanceof ExternalOrdersError) {
          // The owner's own TP/SL or limit order must not silently disarm the
          // protection at the moment it is needed. Keep the rule armed and
          // retry; the reason stays visible until the orders are gone.
          value.state.reason = `${message.replace(/，请先处理后再预览$/, '')}，撤销后自动减仓才会执行；规则保持启用`;
          value.state.retryAt = iso(now() + 30_000);
          if (value.state.reason !== previous) event(value, value.state.reason);
        }
        else {
          value.state.failures += 1;
          // A changed account is never retried on a new binding. Read failures get
          // three attempts, spaced at least 30 s and across process restarts.
          if (error?.status === 409 && !(error instanceof StaleMarketError) || value.state.failures >= 3) {
            value.config.enabled = false; value.state.phase = 'review'; value.state.retryAt = null;
            value.state.reason += '；规则已停用，请核对后重新启用'; event(value, value.state.reason);
          } else value.state.retryAt = iso(Math.max(now() + 30_000, Number.isSafeInteger(error?.retryAt) ? error.retryAt : 0));
        }
        write(value);
      });
    }
  }
  function tick() {
    if (closed || ticking) return ticking ?? Promise.resolve();
    ticking = run().catch(error => log.warn({ type: 'anthropic-reduction', error: error instanceof ExecutionError ? error.message : '自动减仓状态无法持久化' }, '自动减仓检查失败，未启动新任务')).finally(() => { ticking = null; });
    return ticking;
  }
  const timer = intervalMs > 0 ? setInterval(() => void tick(), intervalMs) : null;
  timer?.unref?.();
  function stop() { closed = true; clearInterval(timer); }
  return { state, save, disable, tick, stop, async close() { stop(); await ticking; } };
}
