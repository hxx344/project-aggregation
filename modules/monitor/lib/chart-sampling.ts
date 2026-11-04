const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Reduce SVG cost for long hourly charts. Every bucket keeps its endpoints and
 * each plotted series' extrema; every presence change (data gap break rows,
 * indicator warmup) keeps both neighbours so lines still break where the data does.
 * About 300 buckets keep a noisy series' envelope at roughly 3 px per bucket on a
 * desktop chart; smooth series rarely add points beyond the bucket endpoints.
 * Inputs of up to four points per bucket are returned unchanged.
 */
export function sampleChartPoints<T extends object>(points: readonly T[], keys: readonly (keyof T)[], buckets = 300): readonly T[] {
  if (!keys.length || !(buckets >= 1) || points.length <= buckets * 4) return points;
  const width = Math.ceil(points.length / Math.floor(buckets));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  for (let start = 0; start < points.length; start += width) {
    const end = Math.min(points.length, start + width);
    keep[start] = keep[end - 1] = 1;
    for (const key of keys) {
      let min = -1, max = -1, low = Infinity, high = -Infinity;
      for (let i = start; i < end; i++) {
        const value = finite(points[i][key]);
        if (value === null) continue;
        if (value < low) { low = value; min = i; }
        if (value > high) { high = value; max = i; }
      }
      if (min >= 0) keep[min] = keep[max] = 1;
    }
  }
  for (let i = 1; i < points.length; i++) {
    if (keys.some(key => (finite(points[i][key]) === null) !== (finite(points[i - 1][key]) === null))) keep[i - 1] = keep[i] = 1;
  }
  return points.filter((_, index) => keep[index] === 1);
}
