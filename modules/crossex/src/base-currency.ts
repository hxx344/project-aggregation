export function availableBase(current: string, bases: readonly string[]) {
  return bases.includes(current) ? current : bases.includes('BTC') ? 'BTC' : bases[0] || '';
}

export function matchingBases(bases: readonly string[], query: string) {
  const text = query.trim().toUpperCase();
  if (!text) return bases;
  const matches = bases.filter(base => base.toUpperCase().includes(text));
  return matches.sort((a, b) => Number(b === text) - Number(a === text) || Number(b.startsWith(text)) - Number(a.startsWith(text)) || a.localeCompare(b));
}
