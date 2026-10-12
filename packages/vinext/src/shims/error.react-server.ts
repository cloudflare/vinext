export type { ErrorInfo } from "./error.js";

export function unstable_catchError(): never {
  throw new Error("`unstable_catchError` can only be used in Client Components.");
}

export function catchError(): never {
  throw new Error("`catchError` can only be used in Client Components.");
}
