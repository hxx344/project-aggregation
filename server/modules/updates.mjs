import { requestJson } from '../adapters.mjs';
import { UpdateError } from '../updates.mjs';
import { moduleOrigin } from './transport.mjs';

const tradingModules = ['crossex', 'greeks', 'aster'];
const names = { crossex: 'Gate CrossEx', greeks: 'Greeks', aster: 'Aster 5x' };
export function createModuleUpdateGuard({ request = requestJson } = {}) {
  async function setMaintenance(active) {
    const results = await Promise.allSettled(tradingModules.map(id => request(moduleOrigin(id), '/__workspace/maintenance', {
      method: 'POST', body: { active }, deadline: Date.now() + 10_000,
    })));
    if (results.some(result => result.status === 'rejected' || result.value?.data?.active !== active)) throw new UpdateError(503, '内嵌交易模块的维护状态尚未确认，请重试');
  }
  async function prepareApply() {
    // Independent read-only evidence is checked concurrently after every gate
    // has acknowledged maintenance. Wait for all reads before any rollback.
    const results = await Promise.allSettled(tradingModules.map(async id => {
      let data;
      try { ({ data } = await request(moduleOrigin(id), '/__workspace/update-status', { deadline: Date.now() + (id === 'aster' ? 60_000 : 10_000) })); }
      catch { throw new UpdateError(503, `无法确认 ${names[id]} 的委托状态，请稍后重试`); }
      const detail = id === 'aster' && typeof data?.reason === 'string' && data.reason.length <= 200 ? `：${data.reason}` : '';
      if (typeof data?.busy !== 'boolean' || data.busy) throw new UpdateError(409, `${names[id]} 尚有任务或委托需要核对，暂不能更新${detail}`);
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  return { setMaintenance, prepareApply };
}
