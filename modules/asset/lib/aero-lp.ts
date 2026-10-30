import { z } from 'zod';
import type { Asset, Balance } from './types.ts';
import type { Quote } from './exchanges.ts';

// The workbench sends its Aero LP wallet valuation (server/automation/aero-lp-valuation.mjs) with each sync:
// absent leaves the row untouched, null means no wallet is configured there.
const detail = z.object({ account: z.string().max(80), coin: z.string().max(20), quantity: z.number().finite(), value: z.number().finite() }).strict();
export const aeroLpSchema = z.object({
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/), state: z.string().max(20),
  at: z.string().datetime({ offset: true }).nullable(), staleAfterSec: z.number().int().min(60).max(259_200), total: z.number().finite().nullable(),
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

/** A late request must not replace a newer chain check; null and 'invalid' always apply. */
export function supersedes(next: AeroLpInput | 'invalid', saved: string | undefined) {
  if (next === null || next === 'invalid' || next.at === null || saved === undefined) return true;
  const previous = parseAeroLp({ aeroLp: JSON.parse(saved) });
  return !previous || previous === 'invalid' || previous.at === null || Date.parse(next.at) >= Date.parse(previous.at);
}

export type AeroLpPlan = { type: 'none' } | { type: 'delete'; id: string } | { type: 'save'; asset: Asset };
const shortWallet = (wallet: string) => wallet.slice(0, 6) + '…' + wallet.slice(-4);

const chinaTime = (at: string) => new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');

/**
 * USDC amounts are converted with the ledger's USDC/USD quote. The chain check may lag by up to the LP's own
 * staleAfterSec (its check interval can be hours), so the row is dated by the quote and the check time is in its status;
 * a check older than that limit is an error. A failed valuation keeps the previous value with an error and creates no row.
 */
export function planAeroLp(assets: readonly Asset[], input: AeroLpInput | 'invalid', usdc: Quote | undefined, quoteError: string | undefined, now = Date.now()): AeroLpPlan {
  const current = assets.find(asset => asset.mode === 'aero');
  if (input === null) return current ? { type: 'delete', id: current.id } : { type: 'none' };
  const late = input !== 'invalid' && input.at !== null && now - Date.parse(input.at) > input.staleAfterSec * 1000;
  if (input === 'invalid' || input.error !== null || input.total === null || input.at === null || late || !usdc || !(usdc.price > 0)) {
    const error = input === 'invalid' ? INVALID_AERO_LP : input.error ?? (input.total === null || input.at === null ? 'Aero LP 估值不完整'
      : late ? `Aero LP 链上检查已超过 ${Math.round(input.staleAfterSec / 60)} 分钟未更新` : quoteError ?? 'USDC 报价不可用');
    return current ? { type: 'save', asset: { ...current, status: '同步失败 · 保留旧值', error } } : { type: 'none' };
  }
  let asset = current;
  if (!asset) {
    const nextId = Math.max(0, ...assets.map(a => Number(a.id.slice(4)))) + 1;
    if (assets.length >= 1000 || !Number.isSafeInteger(nextId) || nextId > 999999) return { type: 'none' };
    asset = { id: 'row-' + nextId, project: 'Aero LP', kind: '', quantity: 0, price: 1, value: 0, cell: 'E' + nextId, mode: 'aero', updatedAt: '', status: '' };
  }
  const details: Balance[] = input.details.map(row => ({ ...row, value: row.value * usdc.price, price: row.quantity ? row.value * usdc.price / row.quantity : 0 }));
  const at = Math.min(Date.parse(usdc.at), now);
  return { type: 'save', asset: {
    ...asset, kind: '链上 LP · ' + shortWallet(input.wallet), quantity: input.total, price: usdc.price, value: input.total * usdc.price, details,
    updatedAt: new Date(at).toISOString(), status: `工作台同步 · 链上检查 ${chinaTime(input.at)}${input.state === 'running' ? '' : ' · LP 未运行'}`, error: undefined,
  } };
}
