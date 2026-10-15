import type { Account, Position } from './desk-types';

type PositionsSnapshot = NonNullable<Account['snapshot']>;

export function latestPositionsSnapshot(
  ...candidates: (Account['snapshot'] | null)[]
): Account['snapshot'] {
  let latest: PositionsSnapshot | undefined;
  for (const candidate of candidates) {
    if (
      !candidate ||
      !Array.isArray(candidate.positions) ||
      !Number.isFinite(candidate.timestamp) ||
      candidate.timestamp <= 0 ||
      !Number.isFinite(new Date(candidate.timestamp * 1000).getTime())
    )
      continue;
    if (!latest || candidate.timestamp > latest.timestamp) latest = candidate;
  }
  return latest;
}

export function visiblePositions(
  snapshot?: PositionsSnapshot | null,
): Position[] {
  return Array.isArray(snapshot?.positions)
    ? snapshot.positions.filter((position) => Number(position.qty) !== 0)
    : [];
}

export function strategyPositionLabel(
  position: Pick<Position, 'symbol' | 'side'>,
  symbol: string,
  direction: 'LONG' | 'SHORT',
  marginOnly = false,
): { symbolLabel: string | null; directionLabel: string | null } {
  const matchesSymbol = position.symbol === symbol;
  return {
    symbolLabel: matchesSymbol
      ? marginOnly
        ? '配置币种'
        : '当前策略币种'
      : null,
    directionLabel:
      matchesSymbol && !marginOnly && position.side === direction
        ? direction === 'LONG'
          ? '本组多仓'
          : '本组空仓'
        : null,
  };
}
