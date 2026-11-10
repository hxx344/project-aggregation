/** Pure validation shared by server position readers and browser cash-flow arithmetic. */
export const POSITIONS_INVALID = '仓位数据不完整，已保留上次完整快照';
export function decimal(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error(POSITIONS_INVALID);
  return value;
}
