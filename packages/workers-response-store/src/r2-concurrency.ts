// R2 operations count against the Workers six-connection ceiling.
// https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections
const MAX_R2_CONCURRENCY = 6;

// R2 takes about one write per second to an object key and answers more with 429 (10058).
// https://developers.cloudflare.com/r2/platform/limits/
export const MAX_R2_CAS_ATTEMPTS = 5;
const R2_RETRY_BASE_MS = 250;
// R2 bindings throw a plain Error whose message ends with the R2 error code: 10001 (500),
// 10043 (503) and 10054 (client disconnect) are transient, 10058 (429) is the per-key write
// limit. R2 says to retry all four.
// https://developers.cloudflare.com/r2/api/error-codes/
const RETRYABLE_R2_ERROR = /\((?:10001|10043|10054|10058)\)$/;

export function isRetryableR2Error(error: unknown): error is Error {
  return error instanceof Error && RETRYABLE_R2_ERROR.test(error.message);
}

// Jittered exponential backoff before a retry: 125-375 ms before the second attempt, doubling.
export function waitBeforeR2Retry(attempt: number): Promise<void> {
  return scheduler.wait(R2_RETRY_BASE_MS * 2 ** (attempt - 1) * (0.5 + Math.random()));
}

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
