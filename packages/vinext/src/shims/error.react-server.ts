export type ErrorInfo = {
  error: unknown;
  reset: () => void;
  unstable_retry: () => void;
};

export function unstable_catchError(): never {
  throw new Error("`unstable_catchError` can only be used in Client Components.");
}
