import { z } from 'zod';
import type { Asset, Balance } from './types.ts';
import type { Quote } from './exchanges.ts';

// The workbench sends its Aero LP wallet valuation (server/automation/aero-lp-valuation.mjs) with each sync:
// absent leaves the row untouched, null means no wallet is configured there.
const detail = z.object({ account: z.string().max(80), coin: z.string().max(20), quantity: z.number().finite(), value: z.number().finite() }).strict();
export const aeroLpSchema = z.object({
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/), state: z.string().max(20),
  at: z.string().datetime({ offset: true }).nullable(), total: z.number().finite().nullable(),
  details: z.array(detail).max(100), error: z.string().max(300).nullable(),
}).strict().nullable();
export type AeroLpInput = z.infer<typeof aeroLpSchema>;
export const INVALID_AERO_LP = '工作台发送的 Aero LP 估值格式不正确，保留旧值';

/** undefined: the request carried no Aero LP field; 'invalid': it carried one this version cannot read. */
export function parseAeroLp(body: unknown): AeroLpInput | 'invalid' | undefined {
  if (!body || typeof body !== 'object' || !('aeroLp' in body)) return undefined;
  const parsed = aeroLpSchema.safeParse((body as { aeroLp: unknown }).aeroLp);
  return parsed.success ? parsed.data : 'invalid';
}

export type AeroLpPlan = { type: 'none' } | { type: 'delete'; id: string } | { type: 'save'; asset: Asset };
const shortWallet = (wallet: string) => wallet.slice(0, 6) + '…' + wallet.slice(-4);

/**
 * USDC amounts are converted with the ledger's USDC/USD quote, and the valuation time is the older of the chain
 * cycle and that quote. A failed or incomplete valuation keeps the previous value with an error, and creates no row.
 */
export function planAeroLp(assets: readonly Asset[], input: AeroLpInput | 'invalid', usdc: Quote | undefined, quoteError: string | undefined, now = Date.now()): AeroLpPlan {
  const current = assets.find(asset => asset.mode === 'aero');
  if (input === null) return current ? { type: 'delete', id: current.id } : { type: 'none' };
  if (input === 'invalid' || input.error !== null || input.total === null || input.at === null || !usdc || !(usdc.price > 0)) {
    const error = input === 'invalid' ? INVALID_AERO_LP : input.error ?? (input.total === null || input.at === null ? 'Aero LP 估值不完整' : quoteError ?? 'USDC 报价不可用');
    return current ? { type: 'save', asset: { ...current, status: '同步失败 · 保留旧值', error } } : { type: 'none' };
  }
  let asset = current;
  if (!asset) {
    const nextId = Math.max(0, ...assets.map(a => Number(a.id.slice(4)))) + 1;
    if (assets.length >= 1000 || !Number.isSafeInteger(nextId) || nextId > 999999) return { type: 'none' };
    asset = { id: 'row-' + nextId, project: 'Aero LP', kind: '', quantity: 0, price: 1, value: 0, cell: 'E' + nextId, mode: 'aero', updatedAt: '', status: '' };
  }
  const details: Balance[] = input.details.map(row => ({ ...row, value: row.value * usdc.price, price: row.quantity ? row.value * usdc.price / row.quantity : 0 }));
  const at = Math.min(Date.parse(input.at), Date.parse(usdc.at), now);
  return { type: 'save', asset: {
    ...asset, kind: '链上 LP · ' + shortWallet(input.wallet), quantity: input.total, price: usdc.price, value: input.total * usdc.price, details,
    updatedAt: new Date(at).toISOString(), status: input.state === 'running' ? '工作台同步 · 链上估值时间' : '工作台同步 · LP 未运行', error: undefined,
  } };
}
