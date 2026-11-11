import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../atomic-json.mjs';
import { HttpError } from '../http-common.mjs';

const DEFAULTS = Object.freeze({ interrupted: false, needs_review: false, recovered: false });
const TITLES = { interrupted: '自动调仓中断', needs_review: '自动调仓需要核对', recovered: '自动调仓观察已恢复' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LIMIT = 50, ATTEMPTS = 3, RETRY_MS = 60_000, SEND_MS = 8_000;

/** Observes persisted execution facts. No callback here can execute or resume a trade. */
export function createAeroNotifications({ directory, channel = () => null, now = Date.now }) {
  const file = path.join(directory, 'notifications.json');
  let saved = { schema: 1, config: { ...DEFAULTS }, binding: null, incident: null, history: [] }, error = null, active = null, closed = false, observedBinding = null;
  const persist = next => { try { atomicJson(file, next); saved = next; error = null; } catch { error = '通知状态保存失败，暂停新的发送'; throw new HttpError(503, error); } };
  const view = () => ({ config: { ...saved.config }, history: saved.history.map(({ id, kind, at, status, attempts, reason, error }) => ({ id, kind, at, status, attempts, reason, error })), error, channelConfigured: Boolean(channel()?.alertChannel?.().configured) });
  function initialize() {
    if (!existsSync(file)) return;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('invalid');
      const loaded = JSON.parse(readFileSync(file, 'utf8'));
      if (loaded.schema !== 1 || !Array.isArray(loaded.history) || loaded.history.length > LIMIT || !Object.keys(DEFAULTS).every(key => typeof loaded.config?.[key] === 'boolean')) throw new Error('invalid');
      for (const entry of loaded.history) if (!/^[a-f0-9]{64}$/.test(entry.id) || !(entry.kind in DEFAULTS) || !['pending', 'sending', 'confirmed', 'failed', 'unknown', 'unsubscribed', 'superseded'].includes(entry.status)
        || !Number.isFinite(entry.at) || !Number.isInteger(entry.attempts) || entry.attempts < 0 || entry.attempts > ATTEMPTS || typeof entry.reason !== 'string' || entry.reason.length > 250) throw new Error('invalid');
      saved = loaded;
      // sending was durably claimed before dispatch; its result after restart is unknown.
      if (saved.history.some(entry => entry.status === 'sending')) persist({ ...saved, history: saved.history.map(entry => entry.status === 'sending' ? { ...entry, status: 'unknown', error: '重启前发送结果未知，不重发' } : entry) });
    } catch { error = '通知记录读取失败，保留原文件并暂停通知；投递结果未知'; }
  }
  function observe(input) {
    observedBinding = input?.binding ? hash(input.binding) : null;
    if (error || !observedBinding) return;
    if (input.running && !input.halted) return;
    const binding = observedBinding, next = structuredClone(saved);
    if (binding !== next.binding) {
      // Configuration replacement cannot deliver events from the previous Safe.
      next.binding = binding; next.incident = null; next.history = [];
    }
    const troubled = input.halted || input.needsReview;
    if (troubled || !input.enabled) next.history = supersedeRecoveries(next.history);
    const kind = input.needsReview ? 'needs_review' : troubled ? 'interrupted' : null;
    const key = kind ? hash([binding, kind, input.at]) : null;
    const add = (type, incident) => {
      const id = hash([binding, type, incident]);
      if (next.history.some(entry => entry.id === id)) return;
      next.history.unshift({ id, incident, kind: type, at: now(), status: next.config[type] ? 'pending' : 'unsubscribed', attempts: 0,
        reason: type === 'needs_review' ? '平仓或重开结果未定，请核对原任务' : type === 'interrupted' ? '自动调仓异常停用，请在 Aero 页面核对停止原因' : '已观察到自动调仓重新启用且链上读取正常；不代表成交完成', error: null });
      next.history = next.history.slice(0, LIMIT);
    };
    if (kind && key !== next.incident?.key) { next.incident = { key, kind, at: input.at }; add(kind, key); }
    else if (!kind && next.incident && input.enabled && input.healthy && input.observedAt >= next.incident.at) { add('recovered', next.incident.key); next.incident = null; }
    // A user disabling automation is neither an incident nor a recovery.
    if (JSON.stringify(next) !== JSON.stringify(saved)) persist(next);
  }
  function supersedeRecoveries(history) {
    return history.map(entry => entry.kind === 'recovered' && ['pending', 'failed'].includes(entry.status)
      ? { ...entry, status: 'superseded', error: '恢复依据已变化，未继续发送这条通知' } : entry);
  }
  async function tick({ allowRecovery = true } = {}) {
    if (active || closed || error || !observedBinding || observedBinding !== saved.binding || !channel()?.alertChannel?.().configured) return active;
    const entry = saved.history.find(item => (allowRecovery || item.kind !== 'recovered') && saved.config[item.kind] && (item.status === 'pending' || item.status === 'failed' && item.attempts < ATTEMPTS && now() >= item.retryAt));
    if (!entry) return;
    const binding = saved.binding, id = entry.id;
    const update = patch => {
      if (saved.binding !== binding || !saved.history.some(item => item.id === id)) return;
      persist({ ...saved, history: saved.history.map(item => item.id === id ? { ...item, ...patch } : item) });
    };
    update({ status: 'sending', attempts: entry.attempts + 1, attemptedAt: now() });
    const controller = new AbortController();
    active = (async () => {
      let timeout, outcome;
      try {
        const target = channel(), title = String(target.alertChannel().title ?? '工作台').slice(0, 60);
        const card = { header: { title: { tag: 'plain_text', content: `${title} · ${TITLES[entry.kind]}` } }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: `${entry.reason}\n时间：${new Date(entry.at).toISOString()}\n事件：${entry.id.slice(0, 16)}` } }] };
        await Promise.race([target.postAlert(card, { signal: controller.signal }), new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('通知发送超时，结果未知'), { uncertain: true })); }, SEND_MS); })]);
        outcome = { status: 'confirmed', completedAt: now(), error: null };
      } catch (cause) {
        outcome = { status: cause?.uncertain ? 'unknown' : 'failed', completedAt: now(), retryAt: now() + RETRY_MS,
          error: cause?.uncertain ? '渠道结果未知，不重发' : '渠道明确未接收；最多尝试3次' };
      } finally { clearTimeout(timeout); }
      // A failed ACK write leaves the durable sending claim; it is never recast
      // as a transport refusal eligible for another attempt.
      update(outcome);
    })().finally(() => { active = null; });
    return active;
  }
  return { initialize, observe, tick, view,
    invalidateRecovery() {
      if (error) return;
      const history = supersedeRecoveries(saved.history);
      if (JSON.stringify(history) !== JSON.stringify(saved.history)) persist({ ...saved, history });
    },
    configure(value) {
      if (error) throw new HttpError(503, error);
      if (!value || Object.keys(value).length !== 3 || !Object.keys(DEFAULTS).every(key => typeof value[key] === 'boolean')) throw new HttpError(400, '通知订阅须明确设置中断、需核对和恢复三个开关');
      persist({ ...saved, config: { ...value }, history: saved.history.map(entry => !value[entry.kind] && ['pending', 'failed'].includes(entry.status) ? { ...entry, status: 'unsubscribed' } : entry) });
      return view();
    },
    async close() { closed = true; await active?.catch(() => {}); },
  };
}
