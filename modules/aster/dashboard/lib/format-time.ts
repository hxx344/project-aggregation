export function utcDate(timestamp: number | undefined): string | null {
  if (
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    timestamp < 0
  )
    return null;
  const value = new Date(timestamp * 1000);
  return Number.isFinite(value.getTime())
    ? value.toISOString().slice(0, 10)
    : null;
}

export function utcTime(timestamp: number | undefined): string {
  if (!utcDate(timestamp)) return '时间未知';
  return `${new Date(timestamp! * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}
