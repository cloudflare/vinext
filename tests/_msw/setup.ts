import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./server.js";

/**
 * Hostnames we treat as "local" and let through without an MSW handler.
 *
 * The vitest integration project spins up real HTTP servers (in-process Vite
 * dev servers, prod-built worker entries, fixture proxies) and then hits
 * them via `fetch(\`http://127.0.0.1:<port>/...\`)`. Those requests are not
 * what MSW is meant to catch — MSW exists here to prevent tests from
 * accidentally hitting the public internet, not to mediate test-internal
 * traffic.
 */
const LOCAL_HOSTNAME_PATTERNS = [/^localhost$/, /^127(?:\.\d+){3}$/, /^\[?::1\]?$/];

function isLocalRequest(url: URL): boolean {
  return LOCAL_HOSTNAME_PATTERNS.some((p) => p.test(url.hostname));
}

/**
 * Vitest setup file that boots the MSW server for every worker.
 *
 * `onUnhandledRequest` errors on any unmocked external request. The whole
 * point of moving away from ad-hoc `globalThis.fetch` hijacking is that
 * future tests which forget to mock an outbound request fail loudly instead
 * of silently hitting the network (or worse, leaking through a stale
 * `fetchMock` that a previous test left behind). Local (loopback) requests
 * are bypassed because they target test-owned servers, not the internet.
 */
beforeAll(() => {
  server.listen({
    onUnhandledRequest(request, print) {
      const url = new URL(request.url);
      if (isLocalRequest(url)) {
        // Loopback request to a test-owned server — let it through silently.
        return;
      }
      print.error();
    },
  });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
