/**
 * Cloudflare dev module URL tests — verifies that Vite's module-serving
 * middlewares get the first chance to handle a request before the Cloudflare
 * plugin's `runWorkerFirst` routing sends it to the Worker.
 *
 * See https://github.com/cloudflare/vinext/issues/4005.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { createServer, type Connect, type ViteDevServer } from "vite";
import {
  createCloudflareDevModuleUrlsPlugin,
  VITE_MODULE_MIDDLEWARE_NAMES,
  VITE_STATIC_MIDDLEWARE_NAME,
} from "../packages/vinext/src/plugins/cloudflare-dev-module-urls.js";

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

/** Mirrors Vite's HMR ping middleware, recording the URL it answers. */
function hmrPingMiddleware(calls: string[]): ViteMiddleware {
  return named("viteHMRPingMiddleware", (req, _res, next) => {
    if (req.headers.accept === "text/x-vite-ping") calls.push(`viteHMRPingMiddleware ${req.url}`);
    else next();
  });
}

/** A module graph node with its transformed code and importers. */
type FakeModule = {
  url?: string;
  transformResult?: { code: string } | null;
  importers: { url: string; transformResult: { code: string } | null }[];
};

/** The JS module Vite generates for an imported asset. */
function assetModule(code: string, url = "/asset?import"): FakeModule {
  return { url, transformResult: { code }, importers: [] };
}

/** A file referenced only by an importer, like a CSS `url()` dependency. */
function importedBy(url: string, code: string): FakeModule {
  return { importers: [{ url, transformResult: { code } }] };
}

/**
 * Builds a fake dev server, runs the plugin's `configureServer`, then appends
 * the Cloudflare plugin's `runWorkerFirst` middleware and Vite's internal
 * middlewares after it, in the order they're registered.
 */
function setup(options: {
  enabled: boolean;
  viteMiddlewares: ViteMiddleware[];
  /** Whether the Cloudflare plugin registered its `runWorkerFirst` middleware. */
  runWorkerFirst?: boolean;
  base?: string;
  origin?: string;
  alias?: { find: string | RegExp; replacement: string }[];
  /** Module graph nodes by file, for a single environment. */
  modulesByFile?: Record<string, FakeModule[]>;
}) {
  const stack: { route: string; handle: unknown }[] = [];
  const modulesByFile = options.modulesByFile ?? {};
  const server = {
    config: {
      base: options.base ?? "/",
      root: "/project",
      server: { origin: options.origin },
      assetsInclude: (file: string) => /\.(?:avif|png|svg|wasm)$/.test(file),
      resolve: { alias: options.alias ?? [] },
    },
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

  if (options.runWorkerFirst ?? true) {
    stack.push({
      route: "",
      handle: named("cloudflarePreMiddleware", () => {
        throw new Error("the plugin must not run the Cloudflare middleware");
      }),
    });
  }
  for (const handle of options.viteMiddlewares) stack.push({ route: "", handle });

  /**
   * Sends a request through the plugin's middleware and resolves with the
   * `next` arguments and the request URL at the time `next` was called.
   */
  const run = (url = "/@vite/client", headers: Record<string, string> = {}, method = "GET") => {
    const [middleware] = pluginMiddlewares;
    if (!middleware) throw new Error("expected the plugin to register a middleware");
    const req = { url, headers, method } as Connect.IncomingMessage;
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

  it("leaves Vite's middleware order alone without runWorkerFirst", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      runWorkerFirst: false,
      viteMiddlewares: [passThrough("viteTransformMiddleware", calls)],
    });

    expect(await run()).toEqual({ args: [], url: "/@vite/client" });
    expect(calls).toEqual([]);
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
    pluginMiddlewares[0]?.(
      { url: "/@vite/client", method: "GET" } as Connect.IncomingMessage,
      {},
      () => {
        nextCalled = true;
      },
    );

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

    pluginMiddlewares[0]?.(
      { url: "/docs/@vite/client", method: "GET" } as Connect.IncomingMessage,
      {},
      () => {
        throw new Error("expected the transform middleware to handle the request");
      },
    );

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

  it("answers the HMR client's ping instead of sending it to the Worker", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [
        hmrPingMiddleware(calls),
        passThrough("viteServePublicMiddleware", calls),
        passThrough("viteTransformMiddleware", calls),
      ],
    });

    let answered = false;
    void run("/", { accept: "text/x-vite-ping" }).then(() => {
      answered = true;
    });
    await Promise.resolve();
    expect(answered).toBe(false);
    expect(calls).toEqual(["viteHMRPingMiddleware /"]);

    // A page navigation to the same URL still reaches the Worker
    calls.length = 0;
    expect(await run("/", { accept: "text/html" })).toEqual({ args: [], url: "/" });
    expect(calls).toEqual(["viteTransformMiddleware /"]);
  });

  it("answers the HMR client's ping under a non-root base", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      base: "/docs/",
      viteMiddlewares: [baseMiddleware("/docs/", calls), hmrPingMiddleware(calls)],
    });

    void run("/docs/", { accept: "text/x-vite-ping" });
    await Promise.resolve();
    expect(calls).toEqual(["viteBaseMiddleware /docs/", "viteHMRPingMiddleware /"]);
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
        "/project/app/logo.svg": [assetModule('export default "/app/logo.svg"')],
        "/project/app/bg.png": [
          importedBy(
            "/app/globals.css",
            'const __vite__css = "body { background: url(\\"/app/bg.png\\") }"',
          ),
        ],
        "/project/app/hero.avif": [
          importedBy("/app/hero.css", '.hero { background: image-set("/app/hero.avif" 1x) }'),
        ],
        "/project/app/worker.wasm": [
          importedBy("/app/load.ts", `fetch(new URL("/app/worker.wasm", '' + import.meta.url))`),
        ],
      },
    });

    for (const url of ["/app/logo.svg", "/app/bg.png", "/app/hero.avif", "/app/worker.wasm"]) {
      void run(url);
    }
    await Promise.resolve();
    expect(calls).toEqual([
      "viteTransformMiddleware /app/logo.svg",
      "viteServeStaticMiddleware /app/logo.svg",
      "viteTransformMiddleware /app/bg.png",
      "viteServeStaticMiddleware /app/bg.png",
      "viteTransformMiddleware /app/hero.avif",
      "viteServeStaticMiddleware /app/hero.avif",
      "viteTransformMiddleware /app/worker.wasm",
      "viteServeStaticMiddleware /app/worker.wasm",
    ]);
  });

  it("serves a referenced asset requested with a query or an encoded name", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [
        named("viteServeStaticMiddleware", (req) => {
          calls.push(`viteServeStaticMiddleware ${req.url}`);
        }),
      ],
      modulesByFile: {
        // After HMR, the asset module's URL has a timestamp
        "/project/app/logo.svg": [assetModule('export default "/app/logo.svg?t=1700000000000"')],
        "/project/app/my logo.png": [assetModule('export default "/app/my%20logo.png"')],
        // CSS keeps the URL unencoded
        "/project/app/café.png": [
          importedBy("/app/a.css", 'b { background: url("/app/café.png") }'),
        ],
      },
    });

    // HMR re-requests assets with a `?t=` timestamp
    void run("/app/logo.svg?t=1700000000000");
    void run("/app/my%20logo.png");
    void run("/app/caf%C3%A9.png");
    await Promise.resolve();
    expect(calls).toEqual([
      "viteServeStaticMiddleware /app/logo.svg?t=1700000000000",
      "viteServeStaticMiddleware /app/my%20logo.png",
      "viteServeStaticMiddleware /app/caf%C3%A9.png",
    ]);
  });

  it("sends a URL that cannot be decoded to the Worker", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [passThrough("viteServeStaticMiddleware", calls)],
    });

    expect(await run("/app/%E0%A4%A.png")).toEqual({ args: [], url: "/app/%E0%A4%A.png" });
    expect(calls).toEqual([]);
  });

  it("sends project files that no importer references to the Worker", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [passThrough("viteServeStaticMiddleware", calls)],
      modulesByFile: {
        // Tailwind reports scanned files as dependencies of the stylesheet
        "/project/api/notes.txt": [
          importedBy(
            "/app/globals.css",
            'body { color: red } a::after { content: "/api/notes.txt" }',
          ),
        ],
        // Only part of a longer path or name
        "/project/a.png": [
          {
            importers: [
              {
                url: "/app/a.ts",
                transformResult: { code: `new URL("/assets/a.png", '' + import.meta.url)` },
              },
              { url: "/app/a.css", transformResult: { code: "url(/assets/a.png) url(/a.pngx)" } },
              { url: "/app/b.ts", transformResult: null },
            ],
          },
        ],
        // Inlined as a string, so the browser never requests the file, even
        // when its contents are its own path
        "/project/route.svg": [
          assetModule('export default "/route.svg"', "/route.svg?raw"),
          assetModule('export default "/route.svg"', "/route.svg?import&inline"),
          // A string literal that isn't Vite's `new URL()` output
          importedBy("/app/icon.ts", 'import icon from "/route.svg?raw"; fetch("/route.svg");'),
          // An authored `new URL()` against another base
          importedBy(
            "/app/link.ts",
            'import icon from "/route.svg?raw"; new URL("/route.svg", location.href);',
          ),
        ],
        // A URL character, not a delimiter, and a function other than `url()`
        "/project/data.json": [
          importedBy("/app/a.css", "b { background: url(/x+/data.json); --v: myurl(/data.json) }"),
        ],
        // JSON whose contents are its own path
        "/project/api/value.json": [
          assetModule('export default "/api/value.json"', "/api/value.json?import"),
        ],
      },
    });

    expect(await run("/api/notes.txt")).toEqual({ args: [], url: "/api/notes.txt" });
    expect(await run("/a.png")).toEqual({ args: [], url: "/a.png" });
    expect(await run("/route.svg")).toEqual({ args: [], url: "/route.svg" });
    expect(await run("/data.json")).toEqual({ args: [], url: "/data.json" });
    expect(await run("/api/value.json")).toEqual({ args: [], url: "/api/value.json" });
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
        "/project/app/logo.svg": [assetModule('export default "/docs/app/logo.svg"')],
      },
    });

    pluginMiddlewares[0]?.(
      { url: "/docs/app/logo.svg", method: "GET" } as Connect.IncomingMessage,
      {},
      () => {
        throw new Error("expected the static middleware to handle the request");
      },
    );

    expect(calls).toEqual([
      "viteBaseMiddleware /docs/app/logo.svg",
      "viteServeStaticMiddleware /app/logo.svg",
    ]);
  });

  it("serves an asset whose URL keeps a query, a fragment, or server.origin", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      origin: "http://localhost:5173/",
      viteMiddlewares: [
        named("viteServeStaticMiddleware", (req) => {
          calls.push(`viteServeStaticMiddleware ${req.url}`);
        }),
      ],
      modulesByFile: {
        "/project/app/dark.svg": [assetModule('export default "/app/dark.svg?variant=dark"')],
        "/project/app/icons.svg": [assetModule('export default "/app/icons.svg#icon"')],
        "/project/app/data.json": [
          assetModule('export default "/app/data.json"', "/app/data.json?import&url"),
        ],
        "/project/app/logo.svg": [
          assetModule('export default "http://localhost:5173/app/logo.svg"'),
        ],
      },
    });

    void run("/app/dark.svg?variant=dark");
    void run("/app/icons.svg");
    void run("/app/data.json");
    void run("/app/logo.svg");
    await Promise.resolve();
    expect(calls).toEqual([
      "viteServeStaticMiddleware /app/dark.svg?variant=dark",
      "viteServeStaticMiddleware /app/icons.svg",
      "viteServeStaticMiddleware /app/data.json",
      "viteServeStaticMiddleware /app/logo.svg",
    ]);
  });

  it("sends requests other than GET and HEAD straight to the Worker", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [
        hmrPingMiddleware(calls),
        // Vite's raw fs middleware serves any method
        named("viteServeRawFsMiddleware", (req) => {
          calls.push(`viteServeRawFsMiddleware ${req.url}`);
        }),
        passThrough("viteServeStaticMiddleware", calls),
      ],
      modulesByFile: { "/project/app/logo.svg": [importedBy("/app/a.css", "url(/app/logo.svg)")] },
    });

    expect(await run("/app/logo.svg", {}, "POST")).toEqual({ args: [], url: "/app/logo.svg" });
    expect(await run("/@fs/project/app/logo.svg", {}, "POST")).toEqual({
      args: [],
      url: "/@fs/project/app/logo.svg",
    });
    expect(await run("/", { accept: "text/x-vite-ping" }, "POST")).toEqual({ args: [], url: "/" });
    expect(calls).toEqual([]);
  });

  it("checks the file an alias redirects a referenced URL to", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      alias: [{ find: "/badge.svg", replacement: "/project/package.json" }],
      viteMiddlewares: [passThrough("viteServeStaticMiddleware", calls)],
      modulesByFile: { "/project/badge.svg": [importedBy("/app/a.css", "url(/badge.svg)")] },
    });

    expect(await run("/badge.svg")).toEqual({ args: [], url: "/badge.svg" });
    expect(calls).toEqual([]);
  });

  it("sends public JS and CSS files that the transform middleware rejects to the Worker", async () => {
    const calls: string[] = [];
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [
        named("viteTransformMiddleware", (req, _res, next) => {
          calls.push(`viteTransformMiddleware ${req.url}`);
          next(Object.assign(new Error("Failed to load url"), { code: "ERR_LOAD_PUBLIC_URL" }));
        }),
        passThrough("viteServeRawFsMiddleware", calls),
      ],
    });

    expect(await run("/sw.js")).toEqual({ args: [], url: "/sw.js" });
    expect(await run("/theme.css")).toEqual({ args: [], url: "/theme.css" });
    expect(calls).toEqual(["viteTransformMiddleware /sw.js", "viteTransformMiddleware /theme.css"]);
  });

  it("serves an asset under an encoded base", () => {
    const calls: string[] = [];
    const { pluginMiddlewares } = setup({
      enabled: true,
      base: "/caf%C3%A9/",
      viteMiddlewares: [
        baseMiddleware("/caf%C3%A9/", calls),
        named("viteServeStaticMiddleware", (req) => {
          calls.push(`viteServeStaticMiddleware ${req.url}`);
        }),
      ],
      // Vite writes asset URLs with the decoded base
      modulesByFile: {
        "/project/app/logo.svg": [assetModule('export default "/café/app/logo.svg"')],
      },
    });

    pluginMiddlewares[0]?.(
      { url: "/caf%C3%A9/app/logo.svg", method: "GET" } as Connect.IncomingMessage,
      {},
      () => {
        throw new Error("expected the static middleware to handle the request");
      },
    );

    expect(calls).toEqual([
      "viteBaseMiddleware /caf%C3%A9/app/logo.svg",
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

describe("Vite's internal dev middlewares", () => {
  // The plugin finds Vite's middlewares by function name and falls through
  // silently if Vite renames them, so check the names against a real server.
  it("registers every middleware the plugin looks for", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-dev-module-urls-"));
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      // viteBaseMiddleware is only registered with a non-root base.
      base: "/docs/",
      appType: "custom",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false },
    });
    try {
      const names = server.middlewares.stack.map((layer) =>
        typeof layer.handle === "function" ? layer.handle.name : undefined,
      );
      expect(names).toEqual(
        expect.arrayContaining([...VITE_MODULE_MIDDLEWARE_NAMES, VITE_STATIC_MIDDLEWARE_NAME]),
      );
    } finally {
      await server.close();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
