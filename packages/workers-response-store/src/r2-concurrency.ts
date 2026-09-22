// R2 operations count against the Workers six-connection ceiling.
// https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections
const MAX_R2_CONCURRENCY = 6;

export async function mapSettledWithR2Concurrency<T, R>(
  values: readonly T[],
  callback: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(MAX_R2_CONCURRENCY, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        try {
          results[index] = { status: "fulfilled", value: await callback(values[index]!) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );

  return results;
}
