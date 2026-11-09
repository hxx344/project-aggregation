import { ExecutionError, WaitError, StaleMarketError, ExternalOrdersError, PositionStateError, ReductionMismatchError, exactKeys } from './trading-execution-plan.mjs';
import { normalizeReductionConfig, REDUCTION_TEST_RULE } from './trading-reduction-plan.mjs';
import { immediate } from './control/schema.mjs';
import { EXECUTION_CALL_TIMEOUT_MS } from './control/execution-jobs.mjs';

const FINAL = new Set(['completed', 'stopped']);
const iso = time => new Date(time).toISOString();
const initialState = () => ({ phase: 'disabled', jobId: null, lastJobId: null, previousJobId: null, reason: null, triggeredAt: null, events: [], failures: 0, retryAt: null });
// Spaced reads (>= 30 s apart) before a rule gives up on a read failure, or
// accepts that the remainder after a round changed outside the round.
const RETRY_LIMIT = 3;
// A rule held without sending (another task's lock, an unconfirmed position
// change) is reported once after this long, so a silent stall is visible.
const HELD_NOTICE_MS = 5 * 60_000;
class ChangedError extends ExecutionError {}

/** One explicitly chosen ANT pair. Reads never trigger work; only the leader's bounded tick can do so. */
export function createAnthropicReduction({ db, execution, admit = operation => operation(), readMaintenance = () => false, now = Date.now, intervalMs = 15_000, log = console } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS execution_anthropic_reduction (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, json TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO execution_anthropic_reduction(id,revision,json) VALUES (1,0,?)').run(JSON.stringify({ config: null, accounts: null, state: initialState() }));
  let closed = false, ticking = null, live = null, checkedAt = null;
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
  // A durable, monotonically numbered notice the Feishu watch delivers once:
  // the rule disarmed itself, or a met trigger is held by the owner's orders.
  const notify = (value, message) => { value.notice = { seq: (value.notice?.seq ?? 0) + 1, at: iso(now()), message: String(message).slice(0, 300) }; };
  function testJob(value) {
    if (!value.test?.jobId) return null;
    try { return execution.jobView(value.test.jobId); } catch { return null; }
  }
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
  function stateOf(value) {
    return { generatedAt: iso(now()), revision: value.revision, config: value.config, state: value.state, live, connections: connections(), maintenance: !!readMaintenance(), job: associated(value) ?? (value.state.lastJobId ? execution.jobView(value.state.lastJobId) : null),
      notice: value.notice ?? null, test: value.test ? { ...value.test, job: testJob(value) } : null };
  }
  const state = () => stateOf(record());
  const protectionState = () => {
    const value = record();
    // This separate scheduler deadline never extends live.validUntil or
    // authorizes an order; allow the next timer and its bounded read calls.
    const monitorUntil = !closed && live && checkedAt ? iso(Date.parse(checkedAt) + Math.max(intervalMs, 15_000) + 2 * EXECUTION_CALL_TIMEOUT_MS) : null;
    return { ...stateOf(value), bindings: value.accounts, checkedAt, monitorUntil, available: !closed && execution.coverageAvailable(), locked: !!value.config && !!execution.lockOwner(value.config.legs) };
  };
  function save(body) {
    exactKeys(body, ['revision', 'config', 'confirmLive']);
    const config = normalizeReductionConfig(body.config);
    if (config.enabled && body.confirmLive !== true) throw new ExecutionError(400, '启用前请确认会按规则自动实盘减仓');
    immediate(db, () => {
      const value = record(); checkRevision(value, body.revision);
      const job = associated(value);
      if (job && !FINAL.has(job.status)) throw new ExecutionError(409, '关联减仓任务尚未结束，请先在执行进度核对并停止后再修改');
      // Saving parameters or disabling must not discard unobserved fills,
      // including a job that completed just before this scheduler settled it.
      const previousJobId = value.state.previousJobId ?? (job?.status === 'completed' ? job.id : null);
      if (previousJobId && JSON.stringify(config.legs) !== JSON.stringify(value.config.legs)) throw new ExecutionError(409, '上一轮剩余持仓尚未核对，暂不能更换减仓合约或方向');
      if (config.enabled && readMaintenance()) throw new ExecutionError(409, '系统正在维护，暂不能启用自动减仓');
      if (config.enabled && execution.lockOwner(config.legs)) throw new ExecutionError(409, '所选合约已有未结束任务，请先核对');
      const next = { revision: value.revision, config, accounts: config.enabled ? accountBindings(config) : null, notice: value.notice ?? null, test: value.test ?? null, state: { ...initialState(), events: value.state.events, phase: config.enabled ? 'armed' : 'disabled',
        previousJobId, lastJobId: previousJobId ?? value.state.lastJobId ?? null, triggeredAt: previousJobId ? value.state.triggeredAt : null,
        reason: config.enabled ? '等待核验当前持仓、减仓数量和分批限制；核验通过后才可触发' : null } };
      event(next, config.enabled ? `已绑定当前实盘账户；${next.state.reason}；每轮完成后继续监测，达到阈值时按剩余持仓再次减仓` : '设置已保存，自动减仓未启用'); write(next);
    });
    live = null; checkedAt = null; return state();
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
    const repeatable = job.status === 'completed' && execution.canRepeatRiskReduction(job.id);
    if (repeatable && value.config.enabled) {
      value.state = { ...value.state, phase: 'armed', jobId: null, lastJobId: job.id, previousJobId: job.id, reason: null, failures: 0, retryAt: null, heldSince: null, heldNotified: false };
      event(value, '本轮分批减仓已完成，继续监测；核对剩余持仓后，达到阈值将开始下一轮');
      write(value); live = null; return true;
    }
    const phase = repeatable ? 'completed' : 'review';
    if (value.state.phase === phase && !value.config.enabled && (job.status !== 'completed' || value.state.previousJobId === job.id)) return true;
    value.config.enabled = false; value.state.phase = phase;
    if (job.status === 'completed') value.state.previousJobId = job.id;
    value.state.reason = job.status === 'completed' ? (repeatable ? '本轮分批减仓已完成，新触发已关闭' : '本轮经人工继续后完成，规则已停用；如需持续监测请核对后重新启用') : `减仓任务${job.reason ? '：' + job.reason : '需人工核对'}；规则已停用，请在执行进度处理原任务`;
    event(value, value.state.reason);
    if (phase === 'review') notify(value, value.state.reason);
    write(value); return true;
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
      const result = await admit(() => execution.startRiskReduction(value.config, { ruleId: 'anthropic-reduction', accounts: value.accounts, previousJobId: value.state.previousJobId, check, commit: (jobId, reading) => {
        check();
        const latest = record();
        latest.state = { ...latest.state, phase: 'reducing', jobId, previousJobId: null, triggeredAt: iso(now()), reason: null, failures: 0, retryAt: null, mismatch: null, mismatches: 0, heldSince: null, heldNotified: false };
        event(latest, `任一腿距强平 ≤ ${latest.config.thresholdPercent}%，触发双边总计 ${latest.config.reducePercent}% 分批市价减仓`);
        write(latest); live = reading;
      } }));
      checkedAt = iso(now());
      if (!result.jobId) {
        immediate(db, () => {
          check(); live = result.live;
          const latest = record();
          if (result.exhausted) {
            latest.config.enabled = false; latest.state.phase = 'completed'; latest.state.previousJobId = null;
            latest.state.reason = '两条腿持仓已全部减完，自动减仓已结束'; latest.state.failures = 0; latest.state.retryAt = null;
            event(latest, latest.state.reason); write(latest);
          } else if (latest.state.previousJobId || latest.state.reason || latest.state.failures || latest.state.mismatches || latest.state.heldSince) {
            latest.state.previousJobId = null; latest.state.reason = null; latest.state.failures = 0; latest.state.retryAt = null; latest.state.mismatch = null; latest.state.mismatches = 0;
            latest.state.heldSince = null; latest.state.heldNotified = false; write(latest);
          }
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
        checkedAt = iso(now());
        // A trigger held by the owner's orders keeps its risk reading visible.
        live = error instanceof ExternalOrdersError && error.reading ? error.reading : null;
        const message = error instanceof ExecutionError ? error.message : '自动减仓读取或记录失败，本轮没有新建任务';
        const previous = value.state.reason;
        value.state.reason = message;
        const held = () => {
          value.state.heldSince ??= iso(now());
          if (!value.state.heldNotified && now() - Date.parse(value.state.heldSince) >= HELD_NOTICE_MS) {
            value.state.heldNotified = true;
            const notice = `自动减仓已连续 ${HELD_NOTICE_MS / 60_000} 分钟无法执行：${value.state.reason}`;
            event(value, notice); notify(value, notice);
          }
        };
        if (error instanceof WaitError) { value.state.retryAt = iso(now() + 30_000); held(); }
        else if (error instanceof ExternalOrdersError) {
          // The owner's own TP/SL or limit order must not silently disarm the
          // protection at the moment it is needed. Keep the rule armed and
          // retry; the reason stays visible until the orders are gone.
          value.state.reason = `已达到减仓阈值，但${message.replace(/，请先处理后再预览$/, '')}，撤销后自动减仓才会执行；规则保持启用`;
          value.state.retryAt = iso(now() + 30_000);
          if (value.state.reason !== previous) { event(value, value.state.reason); notify(value, value.state.reason); }
        }
        else if (error instanceof ReductionMismatchError) {
          // ADL, a partial liquidation, a manual change or the owner's TP/SL
          // filling between rounds. Wait for the same reading on spaced reads;
          // then size the next round from the current position instead of
          // disarming the protection when it is most needed.
          // A position still moving resets the count; the held notice below
          // reports that stall instead of leaving it silent.
          value.state.mismatches = value.state.mismatch === message ? (value.state.mismatches ?? 0) + 1 : 1;
          value.state.mismatch = message;
          if (value.state.mismatches >= RETRY_LIMIT) {
            value.state.previousJobId = null; value.state.failures = 0; value.state.retryAt = null; value.state.mismatch = null; value.state.mismatches = 0;
            value.state.heldSince = null; value.state.heldNotified = false;
            value.state.reason = `${message}；连续 ${RETRY_LIMIT} 次读取一致，已改按当前持仓继续监测`;
            event(value, value.state.reason); notify(value, value.state.reason);
          } else {
            value.state.reason = `${message}；等待再次读取确认（${value.state.mismatches}/${RETRY_LIMIT}）`;
            value.state.retryAt = iso(now() + 30_000); held();
          }
        }
        else {
          value.state.failures += 1;
          // A changed account or binding is never retried. Read failures and
          // position states an exchange read can briefly misreport get three
          // attempts, spaced at least 30 s and across process restarts.
          const permanent = error?.status === 409 && !(error instanceof StaleMarketError) && !(error instanceof PositionStateError);
          if (permanent || value.state.failures >= RETRY_LIMIT) {
            value.config.enabled = false; value.state.phase = 'review'; value.state.retryAt = null;
            value.state.reason += '；规则已停用，请核对后重新启用'; event(value, value.state.reason); notify(value, value.state.reason);
          } else value.state.retryAt = iso(Math.max(now() + 30_000, Number.isSafeInteger(error?.retryAt) ? error.retryAt : 0));
        }
        write(value);
      });
    }
  }
  // Manual live check of the reduction path with a simulated trigger: one
  // batch, each leg its venue's minimum close. Never changes the rule's phase,
  // rounds or enablement; refused while a rule round or its reconciliation is open.
  async function test(body) {
    exactKeys(body, ['revision', 'confirmLive']);
    if (body.confirmLive !== true) throw new ExecutionError(400, '测试前请确认会发送双边最小数量的实盘市价减仓委托');
    const value = record(); checkRevision(value, body.revision);
    const ready = latest => {
      if (closed || !execution.leading()) throw new ExecutionError(503, '执行服务暂未取得运行资格，请稍后重试');
      if (readMaintenance()) throw new ExecutionError(409, '系统正在维护，暂不能测试');
      if (latest.revision !== value.revision) throw new ChangedError(409, '自动减仓设置已变化，请刷新后重试');
      if (!latest.config) throw new ExecutionError(409, '请先保存自动减仓设置后再测试');
      const job = associated(latest);
      if (latest.state.jobId || job && !FINAL.has(job.status)) throw new ExecutionError(409, '自动减仓任务尚未结束，暂不能测试');
      if (latest.state.previousJobId) throw new ExecutionError(409, '上一轮减仓后的剩余持仓尚未核对，请稍后再测试');
      const prior = testJob(latest);
      if (prior && !FINAL.has(prior.status)) throw new ExecutionError(409, '上一次测试尚未结束，请在执行进度核对');
    };
    try {
      ready(value);
      await execution.startRiskReduction(value.config, { ruleId: REDUCTION_TEST_RULE, test: true, accounts: accountBindings(value.config), check: () => ready(record()), commit: jobId => {
        const latest = record(); ready(latest);
        latest.test = { jobId, startedAt: iso(now()), error: null };
        event(latest, '已发送自动减仓测试：模拟达到阈值，两腿各按最小下单量市价减仓'); write(latest);
      } });
    } catch (error) {
      if (error instanceof ChangedError) throw error;
      // Persist the refusal as this test's result; nothing was sent.
      const message = error instanceof ExecutionError ? error.message : '测试读取或记录失败，未发送委托';
      try {
        immediate(db, () => {
          if (closed || !execution.leading()) return;
          const latest = record(), prior = testJob(latest);
          // A refusal never replaces the record of a test that is still running.
          if (latest.revision !== value.revision || prior && !FINAL.has(prior.status)) return;
          latest.test = { jobId: null, startedAt: iso(now()), error: message }; write(latest);
        });
      } catch { /* The HTTP error still reports the refusal. */ }
      throw error instanceof ExecutionError ? error : new ExecutionError(502, message);
    }
    return state();
  }
  function tick() {
    if (closed || ticking) return ticking ?? Promise.resolve();
    ticking = run().catch(error => log.warn({ type: 'anthropic-reduction', error: error instanceof ExecutionError ? error.message : '自动减仓状态无法持久化' }, '自动减仓检查失败，未启动新任务')).finally(() => { ticking = null; });
    return ticking;
  }
  const timer = intervalMs > 0 ? setInterval(() => void tick(), intervalMs) : null;
  timer?.unref?.();
  function stop() { closed = true; clearInterval(timer); }
  return { state, protectionState, save, disable, test, tick, stop, async close() { stop(); await ticking; } };
}
