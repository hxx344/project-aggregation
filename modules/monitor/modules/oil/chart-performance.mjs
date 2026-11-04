/** Locate the nearest actual observation without filling missing timestamps. Ties prefer the earlier one. */
export function nearestTimeIndex(rows, target) {
  if (!rows.length) return -1;
  let low = 0, high = rows.length;
  while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].time < target) low = middle + 1; else high = middle; }
  if (!low) return 0;
  if (low === rows.length) return rows.length - 1;
  return target - rows[low - 1].time <= rows[low].time - target ? low - 1 : low;
}
