import { GOLD_OIL_INTERVAL_MS, type GoldOilPoint } from './gold-oil.ts';

export function goldOilStatistics(points: GoldOilPoint[]) {
  const paired = points.filter((point): point is GoldOilPoint & { ratio: number } => point.ratio !== null);
  if (!paired.length) return null;
  let sum = 0, min = paired[0], max = paired[0];
  const months = new Map<string, { month: string; sum: number; count: number }>();
  for (const point of paired) {
    sum += point.ratio;
    if (point.ratio < min.ratio) min = point;
    if (point.ratio > max.ratio) max = point;
    const key = new Date(point.time).toISOString().slice(0, 7), month = months.get(key) ?? { month: key, sum: 0, count: 0 };
    month.sum += point.ratio; month.count++; months.set(key, month);
  }
  const first = paired[0], last = paired.at(-1)!;
  return { first, last, average: sum / paired.length, min, max, count: paired.length, change: last.ratio - first.ratio, percentChange: (last.ratio / first.ratio - 1) * 100, position: max.ratio === min.ratio ? 50 : (last.ratio - min.ratio) / (max.ratio - min.ratio) * 100, months: [...months.values()].map(month => ({ ...month, average: month.sum / month.count })) };
}

/** Reduce SVG cost while retaining every gap boundary and bucket extrema for all views. */
export function sampleGoldOilPoints(points: GoldOilPoint[], budget = 1200) {
  if (points.length <= budget) return points;
  const indices = new Set([0, points.length - 1]);
  const keys = ['ratio', 'xau', 'oil'] as const;
  const width = Math.ceil(points.length / Math.max(1, Math.floor(budget / 8)));
  for (let start = 0; start < points.length; start += width) {
    const end = Math.min(points.length, start + width); indices.add(start); indices.add(end - 1);
    for (const key of keys) {
      let min = -1, max = -1;
      for (let i = start; i < end; i++) if (points[i][key] !== null) {
        if (min < 0 || points[i][key]! < points[min][key]!) min = i;
        if (max < 0 || points[i][key]! > points[max][key]!) max = i;
      }
      if (min >= 0) indices.add(min); if (max >= 0) indices.add(max);
    }
  }
  for (let i = 1; i < points.length; i++) if (keys.some(key => (points[i][key] === null) !== (points[i - 1][key] === null))) { indices.add(i - 1); indices.add(i); }
  return [...indices].sort((a, b) => a - b).map(index => points[index]);
}

export function adjacentRatioChange(points: GoldOilPoint[], index: number) {
  const current = points[index], previous = points[index - 1];
  return previous && current.time - previous.time === GOLD_OIL_INTERVAL_MS && current.ratio !== null && previous.ratio !== null ? current.ratio - previous.ratio : null;
}
