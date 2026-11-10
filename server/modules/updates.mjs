import { requestJson } from '../adapters.mjs';
import { UpdateError } from '../updates.mjs';
import { moduleOrigin } from './transport.mjs';
import { readModuleCapabilities } from './capabilities.mjs';

export const tradingModules = Object.freeze(['crossex', 'greeks', 'aster']);
const names = { crossex: 'Gate CrossEx', greeks: 'Greeks', aster: 'Aster 5x' };
export function createModuleUpdateGuard({ request = requestJson } = {}) {
  /** Rejects with `failed` listing every module that did not acknowledge `active`. */
  async function setMaintenance(active, ids = tradingModules, { deadlineMs = 10_000 } = {}) {
    const results = await Promise.allSettled(ids.map(id => request(moduleOrigin(id), '/__workspace/maintenance', {
      method: 'POST', body: { active }, deadline: Date.now() + deadlineMs,
    })));
    const failed = ids.filter((_, index) => results[index].status === 'rejected' || results[index].value?.data?.active !== active);
    if (failed.length) throw Object.assign(new UpdateError(503, '内嵌交易模块的维护状态尚未确认，请重试'), { failed });
  }
  async function prepareApply() {
    // Independent read-only evidence is checked concurrently after every gate
    // has acknowledged maintenance. Wait for all reads before any rollback.
    const results = await Promise.allSettled(tradingModules.map(async id => {
      let data;
      try { await readModuleCapabilities(id, { request, deadline: Date.now() + 5000 }); }
      catch { throw new UpdateError(503, `${names[id]} 的维护协议无法确认，暂不能更新`); }
      try { ({ data } = await request(moduleOrigin(id), '/__workspace/update-status', { deadline: Date.now() + (id === 'aster' ? 60_000 : 10_000) })); }
      catch { throw new UpdateError(503, `无法确认 ${names[id]} 的委托状态，请稍后重试`); }
      const detail = id === 'aster' && typeof data?.reason === 'string' && data.reason.length <= 200 ? `：${data.reason}` : '';
      if (typeof data?.busy !== 'boolean' || data.busy) throw new UpdateError(409, `${names[id]} 尚未满足安全停机条件，暂不能更新${detail}`);
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  // Display only: never enter maintenance or invoke ASTER's cold-stop check.
  // A short, non-retried request may return unknown; apply keeps its original
  // independent, longer evidence budget and final guard.
  async function readImpact({ signal } = {}) {
    return Promise.all(tradingModules.map(async id => {
      const observedAt = new Date().toISOString();
      try {
        const { data } = await request(moduleOrigin(id), id === 'aster' ? '/__workspace/update-impact' : '/__workspace/update-status', {
          deadline: Date.now() + 4000, signal,
        });
        if (data?.busy !== true && data?.busy !== false && !(id === 'aster' && data?.busy === null && data?.requiresFinalCheck === true)) throw new Error('invalid impact');
        return { moduleId: id, observedAt, busy: data.busy, reasonCode: data.busy === true ? 'module-busy' : data.busy === false ? 'module-idle' : 'final-order-check-required',
          activeRequests: id === 'aster' && Number.isSafeInteger(data.activeRequests) && data.activeRequests >= 0 ? Math.min(data.activeRequests, 100000) : null };
      } catch { return { moduleId: id, observedAt, busy: null, reasonCode: 'module-unavailable', activeRequests: null }; }
    }));
  }
  return { setMaintenance, prepareApply, readImpact };
}
