import { Buffer } from 'node:buffer';
import type { CycleEvidence, HubPositions, PositionCycle } from './positions-types.ts';

/** The Hub's transport accepts 2 MiB. Keep a margin for serialization/forwarding metadata,
 * and spend at most 512 KiB / 1,000 rows on optional evidence across the entire response. */
export const POSITION_EVIDENCE_ROWS = 1000;
export const POSITION_EVIDENCE_BYTES = 512 * 1024;
export const POSITION_RESPONSE_TARGET_BYTES = 2 * 1024 * 1024 - 16 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Project, never trim the cached cycle. An already-large overview gets no extra evidence. */
export function boundPositionEvidence(response: HubPositions): HubPositions {
  const slots: { cycle: PositionCycle; source: CycleEvidence }[] = [];
  const bounded: HubPositions = { ...response, exchanges: response.exchanges.map(exchange => ({ ...exchange,
    accounts: exchange.accounts.map(account => ({ ...account, scopes: account.scopes.map(scope => ({ ...scope,
      positions: scope.positions.map(position => {
        if (!position.cycle?.evidence) return position;
        const { evidence, ...cycle } = position.cycle;
        slots.push({ cycle, source: evidence });
        return { ...position, cycle };
      }),
    })) })),
  })) };
  if (!slots.length) return response;
  let availableBytes = Math.min(POSITION_EVIDENCE_BYTES, Math.max(0, POSITION_RESPONSE_TARGET_BYTES - bytes(bounded)));
  const attached: typeof slots = [];
  for (const slot of slots) {
    // `false` is one byte longer than `true`; reserving it also covers the final truncated flag.
    const evidence: CycleEvidence = { ...slot.source, rows: [], truncated: false };
    const metadataBytes = Buffer.byteLength(',"evidence":', 'utf8') + bytes(evidence);
    if (metadataBytes > availableBytes) continue;
    availableBytes -= metadataBytes; slot.cycle.evidence = evidence; attached.push(slot);
  }
  // Give every attached position a share instead of exhausting the budget on the first few.
  const perPosition = Math.max(1, Math.floor(POSITION_EVIDENCE_ROWS / Math.max(1, attached.length)));
  let remainingRows = POSITION_EVIDENCE_ROWS;
  for (const { cycle, source } of attached) {
    const evidence = cycle.evidence!;
    for (const row of source.rows.slice(0, Math.min(200, perPosition))) {
      const rowBytes = bytes(row) + (evidence.rows.length ? 1 : 0);
      if (remainingRows === 0 || rowBytes > availableBytes) break;
      evidence.rows.push(row); availableBytes -= rowBytes; remainingRows--;
    }
    evidence.truncated = source.truncated || evidence.rows.length < source.totalRows;
  }
  return bounded;
}
