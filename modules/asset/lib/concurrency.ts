// Keep account requests bounded while retaining the input order and per-account results.
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency limit');
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index], index);
    }
  }));
  return results;
}

// Do not release the owner's sync lock while another independent branch is still writing.
export async function settleIndependent(tasks: readonly (() => Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
