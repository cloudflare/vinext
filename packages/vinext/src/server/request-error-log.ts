/**
 * Logs an error vinext also passes to instrumentation's `onRequestError`, as
 * `next start` logs it. `VINEXT_QUIET=1` turns these logs off, like Next.js'
 * `quiet` server option, so an `onRequestError` that redacts errors before
 * recording them is the only place they reach.
 */
export function logRequestError(...args: unknown[]): void {
  if (process.env.VINEXT_QUIET === "1") return;
  console.error(...args);
}
