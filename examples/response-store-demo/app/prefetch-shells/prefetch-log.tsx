"use client";

import { useSyncExternalStore } from "react";

type PrefetchEntry = {
  bytes: number;
  cache: string;
  layout: boolean;
  mode: string;
  renderId: string;
  url: string;
};

let entries: PrefetchEntry[] = [];
const subscribers = new Set<() => void>();

// DEMO: fetch patching for visualization only. Link prefetches go through
// window.fetch, so this records each prefetch response for the log below.
if (typeof window !== "undefined") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if ((init as { purpose?: string } | undefined)?.purpose !== "prefetch") return response;
    const headers = new Headers(init?.headers);
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    void response
      .clone()
      .text()
      .then((body) => {
        entries = [
          ...entries,
          {
            bytes: body.length,
            cache:
              response.headers.get("x-vinext-cache") ??
              response.headers.get("cf-cache-status") ??
              "-",
            // The root layout's nav is in every payload that rendered layouts.
            layout: body.includes("Demo deployments"),
            mode: headers.get("X-Vinext-Rsc-Render-Mode") ?? "full",
            renderId: /"render-id","children":"([^"]+)"/.exec(body)?.[1] ?? "-",
            url: url.pathname + url.search.replace(/[?&]_rsc=[^&]*/, ""),
          },
        ];
        for (const notify of subscribers) notify();
      })
      .catch(() => {});
    return response;
  };
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function PrefetchLog() {
  const log = useSyncExternalStore(
    subscribe,
    () => entries,
    () => entries,
  );

  return (
    <section className="panel">
      <h2>Prefetch log</h2>
      <table data-testid="prefetch-log">
        <thead>
          <tr>
            <th>URL</th>
            <th>Mode</th>
            <th>Cache</th>
            <th>Bytes</th>
            <th>Layouts rendered</th>
            <th>Render ID</th>
          </tr>
        </thead>
        <tbody>
          {log.map((entry, index) => (
            <tr key={index}>
              <td>
                <code>{entry.url}</code>
              </td>
              <td>{entry.mode}</td>
              <td>{entry.cache}</td>
              <td>{entry.bytes}</td>
              <td>{entry.layout ? "yes" : "no"}</td>
              <td>
                <code>{entry.renderId.slice(0, 8)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
