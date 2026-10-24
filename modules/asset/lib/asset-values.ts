import type { Asset, FxStatus } from './types.ts';

type ValuedRow = { value: number | null; mode?: string | null; quantity?: number | null };
export const UNKNOWN_QUANTITY_ERROR = '持仓数量未知，请填写数量后计算估值';

export function knownAssetValue(row: ValuedRow): number | null {
  // Old quote refreshes coerced an unknown market quantity to a zero value.
  if (row.mode === 'market' && row.quantity === null && row.value === 0) return null;
  return typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null;
}

/** Same missing-value rule for JSON projections; row must be an internal SQL expression. */
export function missingValueSql(row: string) {
  return `(COALESCE(json_type(${row}, '$.value'), 'null') NOT IN ('integer','real') OR (json_extract(${row}, '$.mode') = 'market' AND json_type(${row}, '$.quantity') = 'null' AND json_extract(${row}, '$.value') = 0))`;
}

export function sumKnownValues(rows: readonly ValuedRow[]) {
  let total = 0, missingValues = 0;
  for (const row of rows) {
    const value = knownAssetValue(row);
    if (value !== null) total += value;
    else missingValues++;
  }
  return { total, missingValues, partial: missingValues > 0 };
}

type WorkbookRow = ValuedRow & { price?: number | null; formula?: unknown };
const blankWorkbookFields = ['value', 'quantity', 'price', 'formula'] as const;

/** A workbook cell with no value, quantity, price or formula was not held that day; the sheet total counts it as 0. */
export function knownWorkbookValue(row: WorkbookRow): number | null {
  return blankWorkbookFields.every(key => row[key] === null || row[key] === undefined) ? 0 : knownAssetValue(row);
}

export function sumWorkbookValues(rows: readonly WorkbookRow[]) {
  return sumKnownValues(rows.map(row => ({ value: knownWorkbookValue(row) })));
}

/** SQL form of knownWorkbookValue() === null; row must be an internal SQL expression. */
export function workbookMissingValueSql(row: string) {
  const blank = blankWorkbookFields.map(key => `COALESCE(json_type(${row}, '$.${key}'), 'null') = 'null'`).join(' AND ');
  return `(${missingValueSql(row)} AND NOT (${blank}))`;
}

export function snapshotValues(assets: readonly Asset[], fxStatus: Pick<FxStatus, 'error'>, now = Date.now()) {
  const values = sumKnownValues(assets);
  const partial = values.partial || !!fxStatus.error || assets.some(asset => asset.mode !== 'manual' &&
    (!!asset.error || !Number.isFinite(Date.parse(asset.updatedAt)) || now - Date.parse(asset.updatedAt) > 900_000));
  return { ...values, partial };
}

export function quantityValue(quantity: number | null, price: number | null) {
  return quantity === null || price === null ? null : quantity * price;
}

export function withMarketQuantity(asset: Asset, quantity: number | null): Asset {
  const unknown = quantity === null;
  return {
    ...asset, quantity, value: quantityValue(quantity, asset.price),
    status: asset.status.replace(' · 数量待填写', '') + (unknown ? ' · 数量待填写' : ''),
    error: unknown ? UNKNOWN_QUANTITY_ERROR : asset.error === UNKNOWN_QUANTITY_ERROR ? undefined : asset.error,
  };
}

export function refreshMarketAsset(asset: Asset, quote: { price: number; at: string; source: string }): Asset {
  return withMarketQuantity({
    ...asset, price: quote.price, updatedAt: quote.at, status: quote.source + ' · 实时单价', error: undefined,
  }, asset.quantity);
}
