/** Prefer an Error's message over its stringified form; fall back to String(). */
export function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
