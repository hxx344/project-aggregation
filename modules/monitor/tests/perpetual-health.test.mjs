import test from 'node:test';
import assert from 'node:assert/strict';
import { venueHealthReason } from '../lib/perpetual-health.ts';

const now = 1_800_000_000_000;
const venue = { marketCount: 100, lastMessageAt: now, sourceLagMs: 50, sourceLagObservedAt: now, staleBookCount: 0, missingBookCount: 0 };
test('health explains stale books even while independent messages keep the venue connected', () => {
  assert.match(venueHealthReason({ ...venue, staleBookCount: 20 }, now), /部分买卖盘口超过 30 秒/);
  assert.match(venueHealthReason({ ...venue, lastMessageAt: now - 31_000 }, now), /未收到有效行情/);
  assert.match(venueHealthReason({ ...venue, marketCount: 0 }, now), /合约目录/);
  assert.match(venueHealthReason({ ...venue, lastMessageAt: null }, now), /首批有效行情/);
  assert.equal(venueHealthReason({ ...venue, error: '快照接口失败' }, now), '快照接口失败');
  assert.match(venueHealthReason({ ...venue, sourceLagMs: -6000 }, now), /服务器时钟/);
  assert.equal(venueHealthReason({ ...venue, sourceLagMs: -6000, sourceLagObservedAt: now - 31_000 }, now), '盘口更新正常');
});
