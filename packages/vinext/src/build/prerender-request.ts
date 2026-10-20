// Only fetch rejections are transport failures. A response body can abort on
// dynamic usage, so errors while consuming an existing response are not marked.
const failedPrerenderRequests = new WeakSet<Error>();

export function fetchPrerenderServer(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init).catch((error: unknown) => {
    if (error instanceof Error) failedPrerenderRequests.add(error);
    throw error;
  });
}

// Accumulate failures until in-flight renders settle, preserving the original
// errors and reporting route labels in a stable order.
export function createExportRequestFailures(mode: "default" | "export") {
  const failures: { readonly route: string; readonly error: Error }[] = [];
  return {
    record(error: unknown, route: string, urlPath?: string): error is Error {
      if (mode !== "export" || !(error instanceof Error) || !failedPrerenderRequests.has(error)) {
        return false;
      }
      failures.push({
        route: urlPath && urlPath !== route ? `${route} (${urlPath})` : route,
        error,
      });
      return true;
    },
    throwIfAny(): void {
      failures.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
      const first = failures[0];
      if (!first) return;
      const lines = failures.map(({ route, error }) => {
        const cause = error.cause;
        const code =
          typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
        return `  ${route}: ${error.message}${typeof code === "string" ? ` (${code})` : ""}`;
      });
      throw new AggregateError(
        failures.map(({ error }) => error),
        `[vinext] Static export failed: ${failures.length} prerender request${failures.length === 1 ? "" : "s"} failed before a response was received.\n${lines.join("\n")}`,
        { cause: first.error },
      );
    },
  };
}
