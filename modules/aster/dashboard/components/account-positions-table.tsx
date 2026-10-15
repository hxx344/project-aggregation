import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Position } from '@/lib/desk-types';
import { fmt } from '@/lib/desk-format';
import { strategyPositionLabel } from '@/lib/account-positions';

export type PositionStrategy = {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  marginOnly: boolean;
};

export function AccountPositionsTable({
  positions,
  strategy,
  label = '账户完整持仓',
}: {
  positions: Position[];
  strategy?: PositionStrategy;
  label?: string;
}) {
  return (
    <div className="table-scroll account-positions-table">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            <TableHead>市场 / 方向</TableHead>
            <TableHead className="number">数量</TableHead>
            <TableHead className="number">开仓均价</TableHead>
            <TableHead className="number">标记价格</TableHead>
            <TableHead className="number">杠杆</TableHead>
            <TableHead className="number">名义价值</TableHead>
            <TableHead className="number">占用保证金</TableHead>
            <TableHead className="number">预估强平价</TableHead>
            <TableHead className="number">未实现盈亏</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.map((position) => {
            const scope = strategy
              ? strategyPositionLabel(
                  position,
                  strategy.symbol,
                  strategy.direction,
                  strategy.marginOnly,
                )
              : null;
            return (
              <TableRow key={`${position.symbol}-${position.side}`}>
                <TableCell>
                  <div className="position-market">
                    <strong>{position.symbol}</strong>
                    {scope?.symbolLabel ? (
                      <span className="position-strategy-badge">
                        {scope.symbolLabel}
                      </span>
                    ) : null}
                  </div>
                  <span
                    className={`direction ${position.side === 'LONG' ? 'mint' : 'danger'}`}
                  >
                    {position.side === 'LONG' ? (
                      <ArrowUpRight size={14} />
                    ) : (
                      <ArrowDownLeft size={14} />
                    )}{' '}
                    {position.side === 'LONG' ? '多仓' : '空仓'}
                    {scope?.directionLabel ? (
                      <span className="position-managed-direction">
                        · {scope.directionLabel}
                      </span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className="number">
                  {fmt(position.qty) === '—' ? '—' : position.qty}
                </TableCell>
                <TableCell className="number">{fmt(position.entry)}</TableCell>
                <TableCell className="number">{fmt(position.mark)}</TableCell>
                <TableCell className="number">{position.leverage}x</TableCell>
                <TableCell className="number">
                  {fmt(position.notional)}
                </TableCell>
                <TableCell className="number">
                  {fmt(position.occupied_margin)}
                </TableCell>
                <TableCell className="number">
                  {Number(position.liquidation) > 0
                    ? fmt(position.liquidation)
                    : '—'}
                </TableCell>
                <TableCell
                  className={`number ${Number(position.unrealized) < 0 ? 'danger' : 'mint'}`}
                >
                  {fmt(position.unrealized)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
