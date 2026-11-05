import { cashUnits } from './binance-lighter-execution.mjs';

const abs = value => value < 0n ? -value : value;
const sign = value => value < 0n ? -1n : 1n;

// Cost is the positive remaining basis, including for a short. Fees stay separate.
// Integer allocation preserves realized + unrealized = cash + marked inventory.
export const createInventoryLedger = () => ({ quantity: 0n, cost: 0n, realized: 0n, cash: 0n });

export function applyInventoryFill(ledger, side, quantity, cash) {
  if (!['buy', 'sell'].includes(side) || quantity <= 0n || cash <= 0n) throw new TypeError('invalid_inventory_fill');
  const delta = side === 'buy' ? quantity : -quantity;
  ledger.cash -= (side === 'buy' ? 1n : -1n) * cash;
  if (!ledger.quantity || sign(ledger.quantity) === sign(delta)) {
    ledger.quantity += delta; ledger.cost += cash;
    return;
  }
  const closed = abs(ledger.quantity) < quantity ? abs(ledger.quantity) : quantity;
  const basis = ledger.cost * closed / abs(ledger.quantity);
  const proceeds = cash * closed / quantity;
  ledger.realized += sign(ledger.quantity) * (proceeds - basis);
  ledger.cost = quantity > closed ? cash - proceeds : ledger.cost - basis;
  ledger.quantity += delta;
}

export const inventoryUnrealized = (ledger, mark) => ledger.quantity === 0n ? 0n
  : cashUnits(ledger.quantity, mark) - sign(ledger.quantity) * ledger.cost;
