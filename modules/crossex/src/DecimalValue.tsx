import { exact, formatDecimal, formatSigned, signedAmount } from './live-display';
import type { DecimalKind } from './live-display';

/** Compact display with the original decimal available on hover. */
export default function DecimalValue({ value, kind = 'quantity', signed = false, full = false }: {
  value: string | null | undefined; kind?: DecimalKind; signed?: boolean; full?: boolean;
}) {
  const original = signed ? signedAmount(value) : exact(value);
  const displayed = full ? original : signed ? formatSigned(value, kind) : formatDecimal(value, kind);
  return <span className={'numeric-value' + (full ? ' numeric-full' : '')} title={original === '—' ? undefined : original}>{displayed}</span>;
}
