/** Bounded-concurrency map preserving input order. Extracted from the identical
 * copies previously kept in orchestrator.ts and sources/marketTiming.ts.
 */
export async function mapLimited<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Bounded-concurrency forEach for tasks whose results are applied by side effect. */
export async function forEachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  await mapLimited(items, limit, async (item) => { await task(item); });
}
