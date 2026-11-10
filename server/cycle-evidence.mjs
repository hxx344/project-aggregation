
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = value => text(value, 40) && Number.isFinite(Date.parse(value));
const decimal = value => value === null || text(value, 160) && /^-?\d+(?:\.\d+)?$/.test(value);

/** Shared host/module boundary: bounded whitelist, unknown keys never cross the bridge. */
export function parseCycleEvidence(value) {
  if (!record(value) || value.version !== 1 || !timestamp(value.coverageStart) || !timestamp(value.coverageEnd)
    || typeof value.openingFound !== 'boolean' || typeof value.truncated !== 'boolean'
    || !Number.isSafeInteger(value.totalRows) || Number(value.totalRows) < 0 || !Array.isArray(value.rows) || value.rows.length > 200
    || value.totalRows !== value.rows.length && !value.truncated || Number(value.totalRows) < value.rows.length) return null;
  const rows = [];
  for (const row of value.rows) {
    if (!record(row) || !text(row.id, 200) || !timestamp(row.time)
      || !['fill', 'funding', 'realized'].includes(String(row.kind)) || !['included', 'partial', 'excluded'].includes(String(row.status))
      || !['quantity', 'price', 'fraction', 'realizedPnl', 'fee', 'amount'].every(key => decimal(row[key]))
      || row.side !== undefined && row.side !== null && !['buy', 'sell'].includes(row.side)
      || row.closingQuantity !== undefined && !decimal(row.closingQuantity)
      || !['currency', 'feeCurrency'].every(key => row[key] === null || text(row[key], 32))
      || row.reason !== null && !text(row.reason, 300)) return null;
    rows.push({ id: row.id, time: row.time, kind: row.kind, status: row.status,
      ...(row.side !== undefined ? { side: row.side } : {}), ...(row.closingQuantity !== undefined ? { closingQuantity: row.closingQuantity } : {}),
      quantity: row.quantity, price: row.price, fraction: row.fraction,
      realizedPnl: row.realizedPnl, fee: row.fee, amount: row.amount,
      currency: row.currency, feeCurrency: row.feeCurrency, reason: row.reason });
  }
  return { version: 1, coverageStart: value.coverageStart, coverageEnd: value.coverageEnd,
    openingFound: value.openingFound, totalRows: value.totalRows, truncated: value.truncated, rows };
}
