import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { Logger, ViteDevServer } from "vite";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";
import {
  APP_FIXTURE_DIR,
  PAGES_FIXTURE_DIR,
  buildAppFixture,
  buildPagesFixture,
  createIsolatedFixture,
  startFixtureServer,
} from "./helpers.js";

// Ported from Next.js: test/e2e/cancel-request/stream-cancel.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/cancel-request/stream-cancel.test.ts
//
// Next.js derives `request.signal` from the Node ServerResponse
// (signalFromNodeResponse): it aborts with `ResponseAborted` when the response
// closes before finishing, and never after a normally completed response.

type Probe = {
  aborted: boolean;
  reason: string | null;
  cancelled: boolean;
  overridden: boolean;
  timedOut: boolean;
  uploading: boolean;
  abortedWhileUploading: boolean;
} | null;

async function readProbe(baseUrl: string, probePath: string, id: string): Promise<Probe> {
  const response = await fetch(`${baseUrl}${probePath}?mode=status&id=${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Probe;
}

/**
 * Open a request, wait until the handler is running (or, with `waitFor:
 * "chunk"`, until the first streamed bytes arrive), then drop the socket.
 */
async function disconnectMidRequest(
  baseUrl: string,
  probePath: string,
  id: string,
  { query, waitFor }: { query: string; waitFor: "chunk" | "probe" },
): Promise<void> {
  const client = http.request(`${baseUrl}${probePath}?${query}&id=${id}`);
  client.on("error", () => {});
  const firstChunk = new Promise<void>((resolve) => {
    client.on("response", (res) => res.once("data", () => resolve()));
  });
  client.end();
  if (waitFor === "chunk") {
    await firstChunk;
  } else {
    await expect
      .poll(() => readProbe(baseUrl, probePath, id), { timeout: 20_000 })
      .toMatchObject({ aborted: false });
  }
  client.destroy();
}

/** POST a body, read the whole response over a non-keep-alive socket, and wait for it to close. */
async function completeRequest(baseUrl: string, probePath: string, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = http.request(`${baseUrl}${probePath}?mode=complete&id=${id}`, {
      method: "POST",
      headers: { connection: "close", "content-type": "text/plain" },
    });
    client.on("error", reject);
    client.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        if (res.socket?.destroyed) resolve(body);
        else res.socket?.once("close", () => resolve(body));
      });
    });
    client.end("payload");
  });
}

/** An upstream that never responds and records when its request is torn down. */
async function startHangingUpstream() {
  const state = { received: false, closed: false };
  const server = http.createServer((req, res) => {
    state.received = true;
    res.once("close", () => {
      state.closed = true;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return {
    state,
    url: `http://127.0.0.1:${address.port}/hang`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type ProbeTarget = {
  name: string;
  path: string;
  /** Whether the server sends a streamed body live or buffers it first. */
  body: "streamed" | "buffered";
  /** Whether the fixture middleware can override a request header for this path. */
  override: boolean;
  /** Whether the handler receives the request body. */
  upload: boolean;
};

type ExternalRewrite = {
  name: string;
  path: string;
  /** Extra request headers that select the middleware branch. */
  headers?: Record<string, string>;
};

const APP_EXTERNAL_REWRITES: ExternalRewrite[] = [
  { name: "an external rewrite", path: "/middleware-external-rewrite" },
  {
    name: "an external rewrite with middleware request headers",
    path: "/middleware-external-rewrite",
    headers: { "x-middleware-test-request-override": "1" },
  },
];
const PAGES_EXTERNAL_REWRITES: ExternalRewrite[] = [
  { name: "an external rewrite", path: "/external-middleware-rewrite-body" },
  {
    name: "an external rewrite with middleware request headers",
    path: "/external-middleware-rewrite-with-headers",
  },
];

type ServerTarget = {
  name: string;
  /** Next.js aborts with `ResponseAborted`; undefined skips the reason check. */
  reason?: string;
  probes: ProbeTarget[];
  /** Middleware external rewrites that proxy to `x-middleware-test-rewrite-target`. */
  externalRewrites: ExternalRewrite[];
  /**
   * Middleware path whose response body fails with the same
   * ERR_STREAM_PREMATURE_CLOSE code Node reports for a client disconnect.
   */
  truncatedBodyPath?: string;
  start: () => Promise<{ baseUrl: string; close: () => Promise<void>; logger?: Logger }>;
};

/**
 * Build app-basic from a copy. The build helper emits bundles to a temp dir,
 * but vinext still writes `BUILD_ID` and client assets under `<root>/dist`,
 * which app-router-production-server.test.ts builds and serves from when the
 * two files share a CI shard.
 */
async function buildIsolatedAppFixture(): Promise<string> {
  const distDir = path.join(APP_FIXTURE_DIR, "dist");
  const root = await createIsolatedFixture(
    APP_FIXTURE_DIR,
    "vinext-request-cancellation-",
    (src) => src !== distDir && !src.startsWith(distDir + path.sep),
    path.join(APP_FIXTURE_DIR, "node_modules"),
  );
  return buildAppFixture(root);
}

async function startBuiltProdServer(entryPath: string) {
  const outDir = path.dirname(path.dirname(entryPath));
  const { server } = await startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir,
    noCompression: true,
    silent: true,
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startDevServer(fixtureDir: string) {
  const { server, baseUrl }: { server: ViteDevServer; baseUrl: string } =
    await startFixtureServer(fixtureDir);
  return { baseUrl, close: () => server.close(), logger: server.config.logger };
}

const APP_ROUTE_PROBE: ProbeTarget = {
  name: "route handler",
  path: "/api/request-signal",
  body: "streamed",
  override: true,
  upload: true,
};
const PAGES_EDGE_API_PROBE: ProbeTarget = {
  name: "edge API route",
  path: "/api/edge-request-signal",
  body: "streamed",
  override: true,
  upload: true,
};
const PAGES_MIDDLEWARE_PROBE: ProbeTarget = {
  name: "middleware",
  path: "/middleware-request-signal",
  body: "streamed",
  override: false,
  upload: true,
};

const targets: ServerTarget[] = [
  {
    name: "App Router production",
    reason: "ResponseAborted",
    probes: [APP_ROUTE_PROBE],
    externalRewrites: APP_EXTERNAL_REWRITES,
    start: async () => startBuiltProdServer(await buildIsolatedAppFixture()),
  },
  {
    // Served by @vitejs/plugin-rsc through srvx, which owns this signal.
    name: "App Router dev",
    probes: [APP_ROUTE_PROBE],
    externalRewrites: APP_EXTERNAL_REWRITES,
    start: () => startDevServer(APP_FIXTURE_DIR),
  },
  {
    name: "Pages Router production",
    reason: "ResponseAborted",
    // The Pages production server buffers edge API bodies before sending them.
    probes: [{ ...PAGES_EDGE_API_PROBE, body: "buffered" }, PAGES_MIDDLEWARE_PROBE],
    externalRewrites: PAGES_EXTERNAL_REWRITES,
    start: async () => startBuiltProdServer(await buildPagesFixture(PAGES_FIXTURE_DIR)),
  },
  {
    name: "Pages Router dev",
    reason: "ResponseAborted",
    // The Pages dev middleware request carries no body.
    probes: [PAGES_EDGE_API_PROBE, { ...PAGES_MIDDLEWARE_PROBE, upload: false }],
    externalRewrites: PAGES_EXTERNAL_REWRITES,
    truncatedBodyPath: "/middleware-truncated-body",
    start: () => startDevServer(PAGES_FIXTURE_DIR),
  },
];

describe.each(targets)(
  "$name request.signal",
  ({ reason, probes, externalRewrites, truncatedBodyPath, start }) => {
    let baseUrl: string;
    let close: (() => Promise<void>) | undefined;
    let logger: Logger | undefined;

    beforeAll(async () => {
      ({ baseUrl, close, logger } = await start());
      // Compile each probe route up front: dev servers can hold requests to a
      // cold route, which would delay the readiness polls below.
      for (const probe of probes) {
        expect(await readProbe(baseUrl, probe.path, "warmup")).toBeNull();
      }
    }, 120_000);

    afterAll(async () => {
      await close?.();
    });

    const aborted = reason === undefined ? { aborted: true } : { aborted: true, reason };

    it.each(externalRewrites)(
      "stops $name upstream request when the client disconnects",
      async ({ path: rewritePath, headers }) => {
        const upstream = await startHangingUpstream();
        try {
          const client = http.request(`${baseUrl}${rewritePath}`, {
            headers: { ...headers, "x-middleware-test-rewrite-target": upstream.url },
          });
          client.on("error", () => {});
          client.end();
          await expect.poll(() => upstream.state.received, { timeout: 20_000 }).toBe(true);
          client.destroy();
          // The proxy's own timeout is 30 seconds; the disconnect must win.
          await expect.poll(() => upstream.state.closed, { timeout: 3_000 }).toBe(true);
        } finally {
          await upstream.close();
        }
      },
      30_000,
    );

    it.runIf(truncatedBodyPath !== undefined)(
      "reports a response body that fails while the client is still connected",
      async () => {
        if (!logger) throw new Error("Expected a dev server logger");
        const logError = vi.spyOn(logger, "error").mockImplementation(() => {});
        try {
          await fetch(`${baseUrl}${truncatedBodyPath}`)
            .then((response) => response.text())
            .catch(() => {});
          await expect
            .poll(() => logError.mock.calls.map(([message]) => message).join("\n"), {
              timeout: 3_000,
            })
            .toContain("Premature close");
        } finally {
          logError.mockRestore();
        }
      },
      30_000,
    );

    describe.each(probes)("$name", ({ path: probePath, body, override, upload }) => {
      it("aborts when the client disconnects before the response is sent", async () => {
        const id = randomUUID();
        await disconnectMidRequest(baseUrl, probePath, id, {
          query: "mode=hang",
          waitFor: "probe",
        });
        // The handler then returns a streamed body, which must be discarded.
        await expect
          .poll(() => readProbe(baseUrl, probePath, id), { timeout: 3_000 })
          .toMatchObject({ ...aborted, timedOut: false, cancelled: true });
      }, 30_000);

      it("aborts and cancels the body when the client disconnects during a streamed response", async () => {
        const id = randomUUID();
        const logError = logger ? vi.spyOn(logger, "error") : undefined;
        try {
          await disconnectMidRequest(baseUrl, probePath, id, {
            query: "mode=stream",
            waitFor: body === "streamed" ? "chunk" : "probe",
          });
          await expect
            .poll(() => readProbe(baseUrl, probePath, id), { timeout: 3_000 })
            .toMatchObject({ ...aborted, cancelled: true });
          // A client disconnect is not a server error.
          expect(logError?.mock.calls ?? []).toEqual([]);
        } finally {
          logError?.mockRestore();
        }
      }, 30_000);

      it.runIf(override)(
        "still aborts after middleware overrides request headers",
        async () => {
          const id = randomUUID();
          await disconnectMidRequest(baseUrl, probePath, id, {
            query: "mode=hang&override=1",
            waitFor: "probe",
          });
          await expect
            .poll(() => readProbe(baseUrl, probePath, id), { timeout: 3_000 })
            .toMatchObject({ ...aborted, timedOut: false, overridden: true });
        },
        30_000,
      );

      it.runIf(upload)(
        "aborts while the request body is still uploading when the client disconnects",
        async () => {
          const id = randomUUID();
          const client = http.request(`${baseUrl}${probePath}?mode=hang&id=${id}`, {
            method: "POST",
            headers: { "content-length": "100000", "content-type": "text/plain" },
          });
          client.on("error", () => {});
          client.write("partial");
          await expect
            .poll(() => readProbe(baseUrl, probePath, id), { timeout: 20_000 })
            .toMatchObject({ aborted: false, uploading: true });
          client.destroy();
          await expect
            .poll(() => readProbe(baseUrl, probePath, id), { timeout: 3_000 })
            .toMatchObject({ ...aborted, abortedWhileUploading: true });
        },
        30_000,
      );

      it("does not abort after a request body is read and the response completes", async () => {
        const id = randomUUID();
        expect(await completeRequest(baseUrl, probePath, id)).toBe("ok");
        // Give a wrongly attached request/socket `close` listener time to fire.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(await readProbe(baseUrl, probePath, id)).toMatchObject({
          aborted: false,
          reason: null,
        });
      }, 30_000);
    });
  },
);
