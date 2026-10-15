/**
 * Cloudflare dev module URL tests — verifies that Vite's module-serving
 * middlewares get the first chance to handle a request before the Cloudflare
 * plugin's `runWorkerFirst` routing sends it to the Worker.
 *
 * See https://github.com/cloudflare/vinext/issues/4005.
 */
import { describe, it, expect } from "vite-plus/test";
import type { Connect, ViteDevServer } from "vite";
import { createCloudflareDevModuleUrlsPlugin } from "../packages/vinext/src/plugins/cloudflare-dev-module-urls.js";

/** A middleware as Vite registers it; some of Vite's middlewares are async. */
type ViteMiddleware = (
  req: Connect.IncomingMessage,
  res: unknown,
  next: (error?: unknown) => void,
) => unknown;

function named(name: string, middleware: ViteMiddleware): ViteMiddleware {
  Object.defineProperty(middleware, "name", { value: name });
  return middleware;
}

/** Records the URL each middleware sees, then passes the request on. */
function passThrough(name: string, calls: string[]): ViteMiddleware {
  return named(name, (req, _res, next) => {
    calls.push(`${name} ${req.url}`);
    next();
  });
}

/** Mirrors Vite's base middleware for a request under the base. */
function baseMiddleware(base: string, calls: string[]): ViteMiddleware {
  return named("viteBaseMiddleware", (req, _res, next) => {
    calls.push(`viteBaseMiddleware ${req.url}`);
    req.url = req.url?.replace(base.slice(0, -1), "");
    next();
  });
}

/**
 * Builds a fake dev server, runs the plugin's `configureServer`, then appends
 * Vite's internal middlewares after it, in the order Vite registers them.
 */
/** A module graph node: the file's importers and their transformed code. */
type FakeModule = { importers: { transformResult: { code: string } | null }[] };

function setup(options: {
  enabled: boolean;
  viteMiddlewares: ViteMiddleware[];
  base?: string;
  /** Module graph nodes by file, for a single environment. */
  modulesByFile?: Record<string, FakeModule[]>;
}) {
  const stack: { route: string; handle: unknown }[] = [];
  const modulesByFile = options.modulesByFile ?? {};
  const server = {
    config: { base: options.base ?? "/", root: "/project" },
    environments: {
      client: {
        moduleGraph: {
          getModulesByFile: (file: string) =>
            file in modulesByFile ? new Set(modulesByFile[file]) : undefined,
        },
      },
    },
    middlewares: {
      stack,
      use: (handle: unknown) => stack.push({ route: "", handle }),
    },
  } as unknown as ViteDevServer;

  const plugin = createCloudflareDevModuleUrlsPlugin({ isEnabled: () => options.enabled });
  if (typeof plugin.configureServer !== "function") {
    throw new Error("expected a configureServer function");
  }
  // The plugin registers its middleware synchronously, so the hook result can be ignored
  void plugin.configureServer.call({} as never, server);
  const pluginMiddlewares = stack.map((layer) => layer.handle as ViteMiddleware);

  for (const handle of options.viteMiddlewares) stack.push({ route: "", handle });

  /**
   * Sends a request through the plugin's middleware and resolves with the
   * `next` arguments and the request URL at the time `next` was called.
   */
  const run = (url = "/@vite/client") => {
    const [middleware] = pluginMiddlewares;
    if (!middleware) throw new Error("expected the plugin to register a middleware");
    const req = { url } as Connect.IncomingMessage;
    return new Promise<{ args: unknown[]; url: string | undefined }>((resolve) => {
      middleware(req, {}, (...args: unknown[]) => resolve({ args, url: req.url }));
    });
  };

  return { pluginMiddlewares, run };
}

describe("cloudflare dev module URLs plugin", () => {
  it("registers nothing without the Cloudflare plugin", () => {
    const { pluginMiddlewares } = setup({ enabled: false, viteMiddlewares: [] });
    expect(pluginMiddlewares).toHaveLength(0);
  });

  it("stops at the first Vite middleware that handles the request", () => {
    const calls: string[] = [];
    const { pluginMiddlewares } = setup({
      enabled: true,
      viteMiddlewares: [
        passThrough("viteServePublicMiddleware", calls),
        named("viteTransformMiddleware", (req) => {
          calls.push(`viteTransformMiddleware ${req.url}`);
        }),
        passThrough("viteServeRawFsMiddleware", calls),
      ],
    });

    let nextCalled = false;
    pluginMiddlewares[0]?.({ url: "/@vite/client" } as Connect.IncomingMessage, {}, () => {
      nextCalled = true;
    });

    expect(calls).toEqual(["viteTransformMiddleware /@vite/client"]);
    expect(nextCalled).toBe(false);
  });

  it("falls through to the Worker when no Vite middleware handles the request", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [
        passThrough("viteServePublicMiddleware", calls),
        passThrough("viteTransformMiddleware", calls),
        passThrough("viteServeRawFsMiddleware", calls),
        passThrough("viteServeStaticMiddleware", calls),
      ],
    });

    expect(await run("/hello.txt")).toEqual({ args: [], url: "/hello.txt" });
    // Public files must keep reaching the Worker so middleware runs for them,
    // and project files that are not referenced assets must not shadow Worker routes.
    expect(calls).toEqual([
      "viteTransformMiddleware /hello.txt",
      "viteServeRawFsMiddleware /hello.txt",
    ]);
  });

  it("restores the request URL when a Vite middleware rewrites it and falls through", async () => {
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [
        named("viteServeRawFsMiddleware", (req, _res, next) => {
          req.url = "/rewritten";
          next();
        }),
      ],
    });

    expect(await run("/@fs/missing.js")).toEqual({ args: [], url: "/@fs/missing.js" });
  });

  it("strips a non-root base before running the module middlewares", () => {
    const calls: string[] = [];
    const { pluginMiddlewares } = setup({
      enabled: true,
      base: "/docs/",
      viteMiddlewares: [
        baseMiddleware("/docs/", calls),
        passThrough("viteServePublicMiddleware", calls),
        named("viteTransformMiddleware", (req) => {
          calls.push(`viteTransformMiddleware ${req.url}`);
        }),
      ],
    });

    pluginMiddlewares[0]?.({ url: "/docs/@vite/client" } as Connect.IncomingMessage, {}, () => {
      throw new Error("expected the transform middleware to handle the request");
    });

    expect(calls).toEqual([
      "viteBaseMiddleware /docs/@vite/client",
      "viteTransformMiddleware /@vite/client",
    ]);
  });

  it("restores the full URL when a request under a non-root base falls through", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      base: "/docs/",
      viteMiddlewares: [
        baseMiddleware("/docs/", calls),
        passThrough("viteTransformMiddleware", calls),
        passThrough("viteServeRawFsMiddleware", calls),
      ],
    });

    // The Cloudflare plugin matches `runWorkerFirst` against the full URL.
    expect(await run("/docs/_next/static/chunk.js")).toEqual({
      args: [],
      url: "/docs/_next/static/chunk.js",
    });
    expect(calls).toEqual([
      "viteBaseMiddleware /docs/_next/static/chunk.js",
      "viteTransformMiddleware /_next/static/chunk.js",
      "viteServeRawFsMiddleware /_next/static/chunk.js",
    ]);
  });

  it("sends requests outside a non-root base straight to the Worker", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      base: "/docs/",
      viteMiddlewares: [
        // Vite's base middleware answers requests outside the base with a 404 or redirect
        named("viteBaseMiddleware", () => {
          calls.push("viteBaseMiddleware");
        }),
        passThrough("viteTransformMiddleware", calls),
      ],
    });

    expect(await run("/@vite/client")).toEqual({ args: [], url: "/@vite/client" });
    expect(await run("/docs")).toEqual({ args: [], url: "/docs" });
    expect(calls).toEqual([]);
  });

  it("serves an asset whose URL a module that imports it references", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [
        passThrough("viteTransformMiddleware", calls),
        named("viteServeStaticMiddleware", (req) => {
          calls.push(`viteServeStaticMiddleware ${req.url}`);
        }),
      ],
      modulesByFile: {
        "/project/app/logo.svg": [
          {
            importers: [{ transformResult: { code: 'import logo from "/app/logo.svg?import";' } }],
          },
        ],
        "/project/app/bg.png": [
          { importers: [{ transformResult: { code: '"body { background: url(/app/bg.png) }"' } }] },
        ],
      },
    });

    void run("/app/logo.svg");
    void run("/app/bg.png");
    await Promise.resolve();
    expect(calls).toEqual([
      "viteTransformMiddleware /app/logo.svg",
      "viteServeStaticMiddleware /app/logo.svg",
      "viteTransformMiddleware /app/bg.png",
      "viteServeStaticMiddleware /app/bg.png",
    ]);
  });

  it("sends project files that no importer references to the Worker", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [passThrough("viteServeStaticMiddleware", calls)],
      modulesByFile: {
        // Tailwind reports scanned files as dependencies of the stylesheet
        "/project/api/notes.txt": [
          { importers: [{ transformResult: { code: '"body { color: red }"' } }] },
        ],
        // Only part of a longer path or name
        "/project/a.png": [
          {
            importers: [
              { transformResult: { code: '"/assets/a.png" "/a.pngx"' } },
              { transformResult: null },
            ],
          },
        ],
      },
    });

    expect(await run("/api/notes.txt")).toEqual({ args: [], url: "/api/notes.txt" });
    expect(await run("/a.png")).toEqual({ args: [], url: "/a.png" });
    expect(await run("/package.json")).toEqual({ args: [], url: "/package.json" });
    expect(calls).toEqual([]);
  });

  it("serves an asset under a non-root base", () => {
    const calls: string[] = [];
    const { pluginMiddlewares } = setup({
      enabled: true,
      base: "/docs/",
      viteMiddlewares: [
        baseMiddleware("/docs/", calls),
        named("viteServeStaticMiddleware", (req) => {
          calls.push(`viteServeStaticMiddleware ${req.url}`);
        }),
      ],
      modulesByFile: {
        "/project/app/logo.svg": [
          {
            importers: [
              { transformResult: { code: 'import logo from "/docs/app/logo.svg?import";' } },
            ],
          },
        ],
      },
    });

    pluginMiddlewares[0]?.({ url: "/docs/app/logo.svg" } as Connect.IncomingMessage, {}, () => {
      throw new Error("expected the static middleware to handle the request");
    });

    expect(calls).toEqual([
      "viteBaseMiddleware /docs/app/logo.svg",
      "viteServeStaticMiddleware /app/logo.svg",
    ]);
  });

  it("forwards errors passed to next", async () => {
    const error = new Error("transform failed");
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [named("viteTransformMiddleware", (_req, _res, next) => next(error))],
    });

    expect((await run()).args).toEqual([error]);
  });

  it("forwards rejections from async middlewares", async () => {
    const error = new Error("async transform failed");
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [named("viteTransformMiddleware", () => Promise.reject(error))],
    });

    expect((await run()).args).toEqual([error]);
  });

  it("falls through when Vite's middlewares are not found", async () => {
    const { run } = setup({ enabled: true, viteMiddlewares: [] });
    expect(await run()).toEqual({ args: [], url: "/@vite/client" });
  });
});
