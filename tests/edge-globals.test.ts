/**
 * Tests that edge-runtime globals are exposed on `globalThis` for user code
 * that does not explicitly import them.
 *
 * Next.js's edge sandbox installs `AsyncLocalStorage` on the global context
 * (see `packages/next/src/server/web/sandbox/context.ts`). vinext executes
 * user code directly on the Cloudflare Workers runtime, which only exposes
 * `AsyncLocalStorage` via `import { AsyncLocalStorage } from "node:async_hooks"`.
 * Without this shim, fixtures like `.nextjs-ref/test/e2e/edge-async-local-storage/`
 * that do `new AsyncLocalStorage()` without an import fail with
 *   ReferenceError: AsyncLocalStorage is not defined.
 */
import { describe, expect, it } from "vite-plus/test";
import { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";

import { installServerGlobals } from "../packages/vinext/src/server/server-globals.js";
import { handlePagesApiRoute } from "../packages/vinext/src/server/pages-api-route.js";

type GlobalWithAls = typeof globalThis & {
  AsyncLocalStorage?: typeof NodeAsyncLocalStorage;
};

type GlobalWithBrowserGlobals = typeof globalThis & {
  window?: unknown;
  document?: unknown;
};

function defineTemporaryGlobal(key: "window" | "document", value: unknown): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
    writable: true,
  });
}

describe("edge runtime globals", () => {
  it("removes partial browser globals before server code evaluates user modules", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

    try {
      defineTemporaryGlobal("window", { getComputedStyle: undefined, history: undefined });
      defineTemporaryGlobal("document", { documentElement: {} });

      installServerGlobals();

      const g = globalThis as GlobalWithBrowserGlobals;
      expect(typeof g.window).toBe("undefined");
      expect(typeof g.document).toBe("undefined");
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");

      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("shadows inherited browser globals before server code evaluates user modules", () => {
    const originalPrototype = Object.getPrototypeOf(globalThis);
    const inheritedBrowserGlobals = Object.create(originalPrototype) as {
      window: unknown;
      document: unknown;
    };
    inheritedBrowserGlobals.window = { history: undefined };
    inheritedBrowserGlobals.document = { documentElement: {} };

    try {
      Object.setPrototypeOf(globalThis, inheritedBrowserGlobals);

      installServerGlobals();

      const g = globalThis as GlobalWithBrowserGlobals;
      expect(typeof g.window).toBe("undefined");
      expect(typeof g.document).toBe("undefined");
      expect(Object.prototype.hasOwnProperty.call(globalThis, "window")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(globalThis, "document")).toBe(true);
    } finally {
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "document");
      Object.setPrototypeOf(globalThis, originalPrototype);
    }
  });

  it("exposes AsyncLocalStorage on globalThis after loading the pages api route entry", () => {
    // Importing pages-api-route should have side-effect-installed the global
    // (via the server-globals module). Reference handlePagesApiRoute so the
    // import is not tree-shaken in case the test runner gets clever.
    expect(typeof handlePagesApiRoute).toBe("function");

    const g = globalThis as GlobalWithAls;
    expect(g.AsyncLocalStorage).toBeDefined();
    expect(g.AsyncLocalStorage).toBe(NodeAsyncLocalStorage);
  });

  it("lets a Pages API handler use AsyncLocalStorage as a global, like Next.js edge runtime", async () => {
    // This mirrors `.nextjs-ref/test/e2e/edge-async-local-storage/` —
    // user code that does `new AsyncLocalStorage()` with no import.
    const storage = new (globalThis as GlobalWithAls).AsyncLocalStorage!<{ id: string }>();

    const response = await handlePagesApiRoute({
      match: {
        params: {},
        route: {
          pattern: "/api/async",
          module: {
            default: async (req, res) => {
              const id = String(req.headers["req-id"] ?? "");
              await storage.run({ id }, async () => {
                await Promise.resolve();
                res.json(storage.getStore());
              });
            },
          },
        },
      },
      request: new Request("https://example.com/api/async", {
        headers: { "req-id": "req-42" },
      }),
      url: "/api/async",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "req-42" });
  });

  it("preserves per-request isolation across many concurrent invocations", async () => {
    const storage = new (globalThis as GlobalWithAls).AsyncLocalStorage!<{ id: string }>();

    const handler = async (
      req: { headers: Record<string, string | string[] | undefined> },
      res: { json(data: unknown): void },
    ): Promise<void> => {
      const id = String(req.headers["req-id"] ?? "");
      await storage.run({ id }, async () => {
        // Yield to the event loop to expose any context leakage between requests.
        await Promise.resolve();
        await Promise.resolve();
        res.json(storage.getStore());
      });
    };

    const ids = Array.from({ length: 25 }, (_, i) => `req-${i}`);
    const responses = await Promise.all(
      ids.map((id) =>
        handlePagesApiRoute({
          match: {
            params: {},
            route: {
              pattern: "/api/async",
              module: { default: handler },
            },
          },
          request: new Request("https://example.com/api/async", {
            headers: { "req-id": id },
          }),
          url: "/api/async",
        }),
      ),
    );

    for (const [i, response] of responses.entries()) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ id: ids[i] });
    }
  });
});
