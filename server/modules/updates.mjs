import { requestJson } from '../adapters.mjs';
import { UpdateError } from '../updates.mjs';
import { moduleOrigin } from './transport.mjs';

const tradingModules = ['crossex', 'greeks'];
export function createModuleUpdateGuard({ request = requestJson } = {}) {
  async function setMaintenance(active) {
    const results = await Promise.allSettled(tradingModules.map(id => request(moduleOrigin(id), '/__workspace/maintenance', {
      method: 'POST', body: { active }, deadline: Date.now() + 10_000,
    })));
    if (results.some(result => result.status === 'rejected' || result.value?.data?.active !== active)) throw new UpdateError(503, '内嵌交易模块的维护状态尚未确认，请重试');
  }
  async function prepareApply() {
    for (const id of tradingModules) {
      let data;
      try { ({ data } = await request(moduleOrigin(id), '/__workspace/update-status', { deadline: Date.now() + 10_000 })); }
      catch { throw new UpdateError(503, `无法确认 ${id === 'crossex' ? 'Gate CrossEx' : 'Greeks'} 的委托状态，请稍后重试`); }
      if (typeof data?.busy !== 'boolean' || data.busy) throw new UpdateError(409, `${id === 'crossex' ? 'Gate CrossEx' : 'Greeks'} 尚有任务或委托需要核对，暂不能更新`);
    }
  }
  return { setMaintenance, prepareApply };
}
