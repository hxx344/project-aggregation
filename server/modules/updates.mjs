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
  return { setMaintenance, prepareApply };
}
