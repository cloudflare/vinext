import { createElement, type ReactNode } from "react";

export type ReactCacheScopeRunner = <T>(run: () => Promise<T>) => Promise<T>;

type ReactCacheScopePrerenderer = (
  element: ReactNode,
  options: { onError: (error: unknown) => void },
) => Promise<{ prelude: ReadableStream<Uint8Array> }>;

type ReactCacheScopeOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs work inside its own React request cache.
 *
 * `cache()` only memoizes while a Flight request is current, and probes call
 * server components before the real render exists. React has no API to open a
 * cache scope, so the work is hosted in a throwaway Flight prerender. The
 * runner settles once that prerender has finished.
 *
 * It takes Flight's `prerender`, not `renderToReadableStream`: a streaming
 * render resumes awaited work on a timer, which delays every scope whose work
 * does real I/O by about a millisecond.
 */
export function createReactCacheScopeRunner(
  prerender: ReactCacheScopePrerenderer,
): ReactCacheScopeRunner {
  return async <T>(run: () => Promise<T>): Promise<T> => {
    let outcome: ReactCacheScopeOutcome<T> | undefined;
    let renderError: { error: unknown } | undefined;

    async function ReactCacheScopeHost(): Promise<null> {
      // Leave Flight's synchronous pass first: hooks are live only there.
      await Promise.resolve();
      try {
        outcome = { ok: true, value: await run() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      return null;
    }

    const { prelude } = await prerender(createElement(ReactCacheScopeHost), {
      onError(error) {
        renderError ??= { error };
      },
    });
    // Flight ends the cache's lifetime once its output has been read.
    const reader = prelude.getReader();
    while (!(await reader.read()).done) {
      // The host renders nothing.
    }

    if (outcome === undefined) {
      throw (
        renderError?.error ?? new Error("React cache scope prerender ended before its work ran")
      );
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  };
}
