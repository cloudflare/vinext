import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { prerenderApp, prerenderPages } from "../packages/vinext/src/build/prerender.js";
import {
  createExportRequestFailures,
  fetchPrerenderServer,
} from "../packages/vinext/src/build/prerender-request.js";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";
import { appRouter } from "../packages/vinext/src/routing/app-router.js";
import { pagesRouter } from "../packages/vinext/src/routing/pages-router.js";

let root: string;
let server: Server | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prerender-transport-"));
  fs.mkdirSync(path.join(root, "server"));
  fs.writeFileSync(
    path.join(root, "server/vinext-server.json"),
    JSON.stringify({ prerenderSecret: "transport-test-secret" }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function source(name: string): void {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export default function Page() { return null; }\n");
}

async function listen(value: Server): Promise<number> {
  server = value;
  await new Promise<void>((resolve, reject) => {
    value.once("error", reject);
    value.listen(0, "127.0.0.1", resolve);
  });
  const address = value.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  return address.port;
}

async function render(router: "app" | "pages", port: number, mode: "default" | "export") {
  const config = await resolveNextConfig({});
  // A borrowed handle is never operated on by prerender; only its port is used.
  // Keep that HTTP-typed handle separate from the raw TCP reset server.
  const _prodServer = { server: createHttpServer(), port };
  const outDir = path.join(root, "out");
  if (router === "app") {
    return prerenderApp({
      routes: await appRouter(path.join(root, "app")),
      outDir,
      config,
      mode,
      rscBundlePath: path.join(root, "server/index.js"),
      _prodServer,
    });
  }
  return prerenderPages({
    routes: await pagesRouter(path.join(root, "pages")),
    apiRoutes: [],
    pagesDir: path.join(root, "pages"),
    outDir,
    config,
    mode,
    _prodServer,
    _prerenderSecret: "transport-test-secret",
  });
}

describe("prerender transport failures", () => {
  // Next.js treats export failures as fatal and lists affected paths:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/export/index.ts
  it.each(["app", "pages"] as const)("rejects %s export with every reset route", async (router) => {
    source(router === "app" ? "app/z/page.tsx" : "pages/z.tsx");
    source(router === "app" ? "app/a/page.tsx" : "pages/a.tsx");
    const port = await listen(
      createServer((socket) => {
        socket.once("data", () => socket.resetAndDestroy());
      }),
    );

    const outcome = render(router, port, "export");

    await expect(outcome).rejects.toBeInstanceOf(AggregateError);
    const error: unknown = await outcome.catch((reason: unknown) => reason);
    if (!(error instanceof AggregateError)) throw new Error("Expected an AggregateError");
    expect(error.message).toBe(
      "[vinext] Static export failed: 2 prerender requests failed before a response was received.\n" +
        "  /a: fetch failed (ECONNRESET)\n  /z: fetch failed (ECONNRESET)",
    );
    expect(error.errors).toHaveLength(2);
    expect(error.cause).toBe(error.errors[0]);
    for (const original of error.errors) {
      expect(original).toBeInstanceOf(TypeError);
      expect(original).toMatchObject({ cause: { code: "ECONNRESET" } });
    }
    expect(fs.readdirSync(path.join(root, "out"))).toEqual([]);
  });

  it.each(["app", "pages"] as const)(
    "rejects %s export when parameter enumeration resets",
    async (router) => {
      source(router === "app" ? "app/[slug]/page.tsx" : "pages/[slug].tsx");
      const port = await listen(
        createServer((socket) => {
          socket.once("data", () => socket.resetAndDestroy());
        }),
      );

      await expect(render(router, port, "export")).rejects.toThrow(
        /\/.*slug.*: fetch failed \(ECONNRESET\)/,
      );
    },
  );

  it.each(["app", "pages"] as const)(
    "rejects %s export when only the 404 resets",
    async (router) => {
      if (router === "pages") source("pages/404.tsx");
      else fs.mkdirSync(path.join(root, "app"));
      const port = await listen(
        createServer((socket) => {
          socket.once("data", () => socket.resetAndDestroy());
        }),
      );

      await expect(render(router, port, "export")).rejects.toThrow(
        "  /404: fetch failed (ECONNRESET)",
      );
      expect(fs.readdirSync(path.join(root, "out"))).toEqual([]);
    },
  );

  it("keeps skipping speculative request failures outside export", async () => {
    source("app/victim/page.tsx");
    const port = await listen(
      createServer((socket) => {
        socket.once("data", () => socket.resetAndDestroy());
      }),
    );

    const result = await render("app", port, "default");

    expect(result.routes).toEqual([{ route: "/victim", status: "skipped", reason: "dynamic" }]);
  });

  it("keeps a no-store speculative response dynamic during export", async () => {
    source("app/victim/page.tsx");
    const port = await listen(
      createHttpServer((_req, res) => {
        res.writeHead(200, {
          "content-type": "text/html",
          "cache-control": "no-store",
          connection: "close",
        });
        res.end("dynamic");
      }),
    );

    const result = await render("app", port, "export");

    expect(result.routes).toEqual([{ route: "/victim", status: "skipped", reason: "dynamic" }]);
    expect(fs.existsSync(path.join(root, "out/victim.html"))).toBe(false);
    expect(fs.existsSync(path.join(root, "out/victim.txt"))).toBe(false);
  });

  it("does not mark an error from consuming an existing response", async () => {
    expect.assertions(3);
    const original = new Error("stream aborted on dynamic usage");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(original);
        },
      }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const failures = createExportRequestFailures("export");

    const received = await fetchPrerenderServer("http://127.0.0.1/");
    await received.text().catch((error: unknown) => {
      expect(error).toBe(original);
      expect(failures.record(error, "/dynamic")).toBe(false);
    });

    expect(() => failures.throwIfAny()).not.toThrow();
  });

  it("preserves the original rejection object and locates its concrete path", async () => {
    const original = new TypeError("fetch failed", {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(original);
    const failures = createExportRequestFailures("export");

    await fetchPrerenderServer("http://127.0.0.1/").catch((error: unknown) => {
      expect(error).toBe(original);
      failures.record(error, "/blog/:slug", "/blog/hello");
    });

    try {
      failures.throwIfAny();
      throw new Error("Expected export failure");
    } catch (error) {
      if (!(error instanceof AggregateError)) throw error;
      expect(error.cause).toBe(original);
      expect(error.errors).toHaveLength(1);
      expect(error.errors[0]).toBe(original);
      expect(error.message).toContain("  /blog/:slug (/blog/hello): fetch failed (ECONNRESET)");
    }
  });
});
