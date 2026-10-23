import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleTradeMarkers, renderTradeMarkers, createTradeLayer, tradeDetailLines, fillsStatusText } from '../modules/oil/trade-markers.mjs';
import { groupTradeEvents } from '../modules/oil/trades.mjs';
import { chartDomain } from '../modules/oil/data-utils.mjs';
import { fill, fillsReply } from './oil-trades-fixtures.mjs';

const start = Date.parse(fill().time), bar = 900_000;
const rows = [0, 1, 2, 3].map(i => ({ time: start + i * bar, date: new Date(start + i * bar).toISOString(), spread: 2 + i }));
const eventAt = (time, spread = null) => ({ ...groupTradeEvents([fill({ key: String(time), time: new Date(time).toISOString() })])[0], spread });
test('identical venue display names get distinct source labels without exposing internal ids', () => {
  const items = [fill({ sourceId: 'internal-project-a', price: '80' }), fill({
    key: 'bz', sourceId: 'internal-project-b', symbol: 'BZUSDT', base: 'BZ', quantityUnit: 'BZ', price: '88', side: 'sell', positionAfter: '-2',
  })];
  const details = source => tradeDetailLines(visibleTradeMarkers(groupTradeEvents(source), rows)[0], String).join('\n');
  const duplicateNames = details(items);
  assert.match(duplicateNames, /资产账本（来源 1） · Binance · 主账户 · 单腿/);
  assert.match(duplicateNames, /资产账本（来源 2） · Binance · 主账户 · 单腿/);
  assert.equal(duplicateNames.includes('internal-project-'), false);
  assert.equal(duplicateNames.includes('成交价差 10.000%'), false);
  assert.equal(details([items[0], { ...items[1], account: '另一个账户' }]).includes('（来源 '), false, 'distinct displayed venues need no disambiguation');
});

test('markers use real fill time and filter to the visible range with a bounded nearest-candle fallback', () => {
  const markers = visibleTradeMarkers([eventAt(start - 1, 1), eventAt(start, 12), eventAt(start + 120_000), eventAt(start + 3 * bar), eventAt(start + 3 * bar + 1, 1)], rows);
  assert.equal(markers.length, 3); assert.equal(markers[0].value, 12); assert.equal(markers[0].basis, '成交价差');
  assert.equal(markers[1].event.time, start + 120_000); assert.equal(markers[1].value, 2); assert.equal(markers[1].basis, '图表价差');
  assert.equal(markers[2].value, 5);
  assert.equal(visibleTradeMarkers([eventAt(start + 2 * bar)], [rows[0], { ...rows[3], time: start + 4 * bar }])[0].value, null, 'a historical gap is not bridged with a remote candle');
  assert.deepEqual(visibleTradeMarkers([eventAt(start)], []), []);
});

class Element {
  constructor(ownerDocument, tag) { this.ownerDocument = ownerDocument; this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.style = {}; this.hidden = false; this.clientWidth = 500; this.offsetWidth = 200; }
  set innerHTML(_value) { throw Error('User-controlled content must never reach HTML'); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  focus() { this.listeners.focus?.({ stopPropagation() {} }); }
  scrollIntoView() {}
}
const doc = { createElementNS: (_ns, tag) => new Element(doc, tag), createElement: tag => new Element(doc, tag) };
const chartFor = markers => {
  const domain = chartDomain([...rows.map(row => row.spread), ...markers.map(marker => marker.value).filter(value => value !== null)]);
  return { width: 500, x: time => (time - start) / bar * 100, y: value => 20 + (domain.max - value) / (domain.max - domain.min) * 200 };
};
test('SVG markers remain within an expanded domain and show details on pointer, focus and keyboard', () => {
  const markers = visibleTradeMarkers([eventAt(start + 120_000, 40), eventAt(start + bar, -20)], rows);
  const chart = chartFor(markers), svg = new Element(doc, 'svg'), shown = []; let hidden = 0;
  const nodes = renderTradeMarkers(svg, markers, chart, { formatTime: String, show: marker => shown.push(marker.event.time), hide: () => hidden++ });
  assert.equal(nodes.size, 2);
  for (const marker of markers) {
    const node = nodes.get(marker.event.key), coordinates = node.attributes.transform.match(/translate\(([^,]+),([^)]+)\)/);
    assert.equal(Number(coordinates[1]), chart.x(marker.event.time));
    assert.ok(Number(coordinates[2]) >= 20 && Number(coordinates[2]) <= 220);
    assert.equal(node.attributes.role, 'button'); assert.equal(node.attributes.tabindex, '0');
    node.focus(); node.listeners.pointermove({ stopPropagation() {} });
    node.listeners.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    node.listeners.keydown({ key: 'Escape', stopPropagation() {} });
  }
  assert.equal(shown.length, 6); assert.equal(hidden, 2);
});

test('tooltip, list and account names use safe text and unknown cash flows stay explicit', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const event = groupTradeEvents([fill({ account: malicious, realizedPnl: null, fee: null, feeCurrency: null })])[0];
  const markers = visibleTradeMarkers([event], rows);
  const elements = new Map(['trade-tooltip', 'oil-trade-details', 'main-chart', 'oil-trades', 'oil-trades-status', 'oil-trades-list'].map(id => [id, new Element(doc, 'div')]));
  const layer = createTradeLayer({ getElementById: id => elements.get(id) }, String);
  layer.render({ markers, chart: chartFor(markers), view: 'spread', fillsView: fillsReply(), beforeShow() {} });
  elements.get('oil-trades-list').children[0].listeners.click();
  const tooltip = elements.get('trade-tooltip');
  assert.ok(tooltip.textContent.includes(malicious)); assert.ok(tooltip.textContent.includes('已实现盈亏 未知'));
  assert.ok(tooltip.textContent.includes('图表价差')); assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.children.length, 0, 'no HTML nodes were created from the account name');
  assert.ok(tradeDetailLines(markers[0], String).some(line => line.includes('开仓 2 CL')));
  layer.render({ markers, chart: chartFor(markers), view: 'prices', fillsView: fillsReply(), beforeShow() {} });
  assert.equal(elements.get('oil-trades').hidden, true); assert.equal(tooltip.hidden, true);
});

test('coverage states retain actual successful source time and distinguish unsupported, stale and partial data', () => {
  assert.match(fillsStatusText({ ...fillsReply(), status: 'standalone' }, String), /请在工作台中查看/);
  assert.match(fillsStatusText({ ...fillsReply(), status: 'unsupported' }, String), /版本不支持/);
  const view = { ...fillsReply(), retained: true, incomplete: true, truncated: true, status: 'unavailable', coverage: [{ ...fillsReply().coverage[0], status: 'stale' }] };
  const result = fillsStatusText(view, String);
  for (const label of ['部分账户失败', '保留上次成功数据', '已截断', '最近 85 天', '仅支持 Binance、Bybit、OKX', fillsReply().coverage[0].fetchedAt]) assert.ok(result.includes(label));
  assert.equal(result.includes(fillsReply().generatedAt), false, 'response generation never refreshes stale source time');
});
