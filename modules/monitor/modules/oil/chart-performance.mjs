export const TABLE_PAGE_SIZE = 200;

/** Locate the nearest actual observation without filling missing timestamps. Ties prefer the earlier one. */
export function nearestTimeIndex(rows, target) {
  if (!rows.length) return -1;
  let low = 0, high = rows.length;
  while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].time < target) low = middle + 1; else high = middle; }
  if (!low) return 0;
  if (low === rows.length) return rows.length - 1;
  return target - rows[low - 1].time <= rows[low].time - target ? low - 1 : low;
}

/** The full validated history stays available; only table DOM is bounded. */
export function tablePage(rows, requestedPage) {
  const pages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, requestedPage));
  const end = rows.length - page * TABLE_PAGE_SIZE;
  return { page, pages, first: rows.length ? page * TABLE_PAGE_SIZE + 1 : 0, last: Math.min(rows.length, (page + 1) * TABLE_PAGE_SIZE), rows: rows.slice(Math.max(0, end - TABLE_PAGE_SIZE), end).reverse() };
}

export function samePriceRows(previous, next) {
  return previous.length === next.length && next.every((row, index) => row.time === previous[index].time && row.brent === previous[index].brent && row.wti === previous[index].wti);
}
