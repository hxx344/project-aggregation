// Keep gaps and local extrema when reducing payloads; never interpolate missing marks.
function compact(rows, keys, limit = 600) {
  if (rows.length <= limit) return rows;
  const width = Math.ceil(rows.length / (limit / (2 + keys.length * 3))), result = [];
  for (let i = 0; i < rows.length; i += width) {
    const bucket = rows.slice(i, i + width);
    const selected = new Set([bucket[0], bucket.at(-1)]);
    for (const key of keys) {
      const valid = bucket.filter(x => Number.isFinite(x[key]));
      if (bucket.some(x => x[key] === null)) selected.add(bucket.find(x => x[key] === null));
      if (valid.length) { selected.add(valid.reduce((a, b) => a[key] < b[key] ? a : b)); selected.add(valid.reduce((a, b) => a[key] > b[key] ? a : b)); }
    }
    result.push(...[...selected].sort((a, b) => a.at - b.at));
  }
  return result;
}
export function analyticsView(store, config) {
  const samples = store.samples('equity');
  const positions = store.prepare("SELECT id,json_extract(json,'$.base') AS base,json_extract(json,'$.entryGrossBps') AS entry FROM positions ORDER BY opened_at DESC LIMIT 50").all().map(p => {
    const rows = store.samples(p.id), spreads = rows.map(x => x.spreadBps).filter(Number.isFinite);
    const maxExitSpreadBps = spreads.length ? Math.max(...spreads) : null;
    return { positionId: p.id, base: p.base, maxExitSpreadBps, maxAdverseSpreadBps: maxExitSpreadBps !== null && Number.isFinite(p.entry) ? Math.max(0, maxExitSpreadBps - p.entry) : null, samples: compact(rows, ['spreadBps', 'net']) };
  });
  return { samples: compact(samples, ['equity', 'priceOnlyEquity', 'drawdown']), maxDrawdown: store.get('maxDrawdown', null), latestAt: samples.at(-1)?.at ?? null, retainedFrom: samples[0]?.at ?? null, sampleSeconds: config.historySampleSeconds, positions };
}
export function sampleAnalytics(store, positions, totals, now) {
  const c = store.config(), last = store.get('sampleAt', 0);
  if (now - last < c.historySampleSeconds * 1000) return;
  const priceOnlyEquity = totals.unrealizedPnl === null ? null : totals.realizedPnl + totals.unrealizedPnl;
  const equity = totals.netWithFunding, previousPeak = store.get('equityPeak', null);
  const peak = equity === null ? previousPeak : Math.max(previousPeak ?? equity, equity);
  const drawdown = equity === null ? null : peak - equity;
  const times = positions.map(p => p.valuation.at).filter(Number.isFinite);
  store.transaction(() => {
    if (last && now - last > c.historySampleSeconds * 2000) {
      const gapAt = last + c.historySampleSeconds * 1000;
      store.sample('equity', gapAt, { at: gapAt, sourceAt: null, realized: null, unrealized: null, equity: null, priceOnlyEquity: null, drawdown: null });
      for (const p of positions) if (p.openedAt <= gapAt) store.sample(p.id, gapAt, { at: gapAt, sourceAt: null, spreadBps: null, net: null });
    }
    store.sample('equity', now, { at: now, sourceAt: times.length ? Math.min(...times) : null, realized: totals.realizedPnl, unrealized: totals.unrealizedPnl, equity, priceOnlyEquity, drawdown });
    if (equity !== null) { store.set('equityPeak', peak); store.set('maxDrawdown', Math.max(store.get('maxDrawdown', 0) ?? 0, drawdown)); }
    for (const p of positions) store.sample(p.id, now, { at: now, sourceAt: p.valuation.at, spreadBps: p.valuation.stale ? null : p.valuation.spreadBps ?? null, net: p.valuation.stale ? null : p.valuation.netWithFunding ?? null });
    store.set('sampleAt', now);
    store.prepare('DELETE FROM samples WHERE at<?').run(now - 90 * 86400000);
  });
}
