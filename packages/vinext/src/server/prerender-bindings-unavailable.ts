/**
 * Marks the errors that the build-time prerender's stand-in for
 * `cloudflare:workers` throws, as its bindings aren't available there. Such an
 * error doesn't fail the build: the route is skipped, or keeps what its
 * boundaries render for it, as before render errors failed the build.
 */
export const PRERENDER_BINDINGS_UNAVAILABLE_KEY = "vinext.prerender.bindingsUnavailable";

// The server error a sanitized client error stands in for (app-rsc-errors.ts).
const ORIGINAL_SERVER_ERROR = Symbol.for("vinext.originalServerError");

export function isPrerenderBindingsUnavailableError(error: unknown): boolean {
  const marker = Symbol.for(PRERENDER_BINDINGS_UNAVAILABLE_KEY);
  // Follow a sanitized error's original or a wrapping error's cause, without
  // looping on a cyclic chain.
  const visited = new WeakSet<object>();
  while (error !== null && typeof error === "object" && !visited.has(error)) {
    visited.add(error);
    if (Reflect.get(error, marker) === true) return true;
    error =
      ORIGINAL_SERVER_ERROR in error
        ? Reflect.get(error, ORIGINAL_SERVER_ERROR)
        : Reflect.get(error, "cause");
  }
  return false;
}
