import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeDetailLines, fillsStatusText } from '../modules/oil/trade-markers.mjs';
import { groupTradeEvents } from '../modules/oil/trades.mjs';
import { spreadTradeMarkers } from '../lib/hynix-trades.ts';
import { fill, fillsReply } from './oil-trades-fixtures.mjs';

const start = Date.parse(fill().time), bar = 900_000;
const point = (i, premium = 2 + i, spread = 1.5 + i) => ({ time: start + i * bar, adr: 80 + spread, ordinary: 80, equivalent: 80, premium, spread });
const rows = [0, 1, 2, 3].map(i => point(i));
// Mirrors OIL_SPREAD_CHART: 15-minute bars, one WTI barrel per Brent barrel.
const oilMarkers = (events, points = rows) => spreadTradeMarkers(events, points, { intervalMs: bar, rightPerUnit: 1, tradedBasis: '成交价差', chartBasis: '图表价差' });
const eventAt = (time, spread = null) => ({ ...groupTradeEvents([fill({ key: String(time), time: new Date(time).toISOString() })])[0], spread });
test('identical venue display names get distinct source labels without exposing internal ids', () => {
  const items = [fill({ sourceId: 'internal-project-a', price: '80' }), fill({
    key: 'bz', sourceId: 'internal-project-b', symbol: 'BZUSDT', base: 'BZ', quantityUnit: 'BZ', price: '88', side: 'sell', positionAfter: '-2',
  })];
  const details = source => tradeDetailLines(oilMarkers(groupTradeEvents(source))[0], String).join('\n');
  const duplicateNames = details(items);
  assert.match(duplicateNames, /资产账本（来源 1） · Binance · 主账户 · 单腿/);
  assert.match(duplicateNames, /资产账本（来源 2） · Binance · 主账户 · 单腿/);
  assert.equal(duplicateNames.includes('internal-project-'), false);
  assert.equal(duplicateNames.includes('成交价差 10.000%'), false);
  assert.equal(details([items[0], { ...items[1], account: '另一个账户' }]).includes('（来源 '), false, 'distinct displayed venues need no disambiguation');
});

test('oil markers use the 15-minute bar containing the fill and never bridge a gap', () => {
  const markers = oilMarkers([eventAt(start - 1, 1), eventAt(start, 12), eventAt(start + 120_000), eventAt(start + 3 * bar), eventAt(start + 3 * bar + 1, 1)]);
  assert.equal(markers.length, 4, 'fills before the first bar are outside the chart');
  assert.equal(markers[0].value, 12); assert.equal(markers[0].basis, '成交价差');
  assert.equal(markers[1].event.time, start + 120_000); assert.equal(markers[1].value, 2); assert.equal(markers[1].basis, '图表价差');
  assert.equal(markers[2].value, 5); assert.equal(markers[3].value, 1); assert.equal(markers[3].chartSpread, 5);
  const [gap] = oilMarkers([eventAt(start + 2 * bar)], [rows[0], point(4)]);
  assert.equal(gap.value, null, 'a historical gap is not bridged with a remote candle');
  assert.equal(gap.usd, null);
  assert.deepEqual(oilMarkers([eventAt(start)], []), []);
});

test('absolute oil markers use paired fill prices per barrel and fall back to the chart bar', () => {
  const paired = groupTradeEvents([fill({ price: '66.2' }), fill({ key: 'bz', symbol: 'BZUSDT', base: 'BZ', quantityUnit: 'BZ', price: '70.1', side: 'sell', positionAfter: '-2' })]);
  const [traded] = oilMarkers(paired);
  assert.equal(traded.usd.toFixed(3), '3.900'); assert.equal(traded.basis, '成交价差'); assert.equal(traded.chartSpread, 2);
  assert.equal(traded.value, paired[0].spread, 'the percent value comes from the traded spread');
  const [single] = oilMarkers([eventAt(start + bar, 12)]);
  assert.equal(single.usd, 2.5, 'a single-leg event falls back to the chart bar');
});

test('trade details keep user-controlled names as text and unknown cash flows stay explicit', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const event = groupTradeEvents([fill({ account: malicious, realizedPnl: null, fee: null, feeCurrency: null })])[0];
  const lines = tradeDetailLines(oilMarkers([event])[0], String);
  assert.ok(lines.some(line => line.includes(malicious)));
  assert.ok(lines.some(line => line.includes('已实现盈亏 未知')));
  assert.ok(lines.some(line => line.includes('图表价差')));
  assert.ok(lines.some(line => line.includes('开仓 2 CL')));
});

test('coverage states retain actual successful source time and distinguish unsupported, stale and partial data', () => {
  assert.match(fillsStatusText({ ...fillsReply(), status: 'standalone' }, String), /请在工作台中查看/);
  assert.match(fillsStatusText({ ...fillsReply(), status: 'unsupported' }, String), /版本不支持/);
  const view = { ...fillsReply(), retained: true, incomplete: true, truncated: true, status: 'unavailable', coverage: [{ ...fillsReply().coverage[0], status: 'stale' }] };
  const result = fillsStatusText(view, String);
  for (const label of ['部分账户失败', '保留上次成功数据', '已截断', '最近 85 天', '仅支持 Binance、Bybit、OKX', fillsReply().coverage[0].fetchedAt]) assert.ok(result.includes(label));
  assert.equal(result.includes(fillsReply().generatedAt), false, 'response generation never refreshes stale source time');
});

test('a pending refresh over stored fills says it is updating in the background', () => {
  assert.match(fillsStatusText({ ...fillsReply(), pending: true, retained: false }, String), /^已显示上次成交，后台更新中…/);
  const cold = { ...fillsReply(), pending: true, retained: false, items: [], coverage: [{ ...fillsReply().coverage[0], status: 'loading', fetchedAt: null }] };
  assert.match(fillsStatusText(cold, String), /^读取中…/);
});
