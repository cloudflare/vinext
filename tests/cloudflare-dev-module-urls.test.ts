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

function passThrough(name: string, calls: string[]): ViteMiddleware {
  return named(name, (_req, _res, next) => {
    calls.push(name);
    next();
  });
}

/**
 * Builds a fake dev server, runs the plugin's `configureServer`, then appends
 * Vite's internal middlewares after it, in the order Vite registers them.
 */
function setup(options: { enabled: boolean; viteMiddlewares: ViteMiddleware[] }) {
  const stack: { route: string; handle: unknown }[] = [];
  const server = {
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

  /** Sends a request through the plugin's middleware and resolves with the `next` arguments. */
  const run = () => {
    const [middleware] = pluginMiddlewares;
    if (!middleware) throw new Error("expected the plugin to register a middleware");
    return new Promise<unknown[]>((resolve) => {
      middleware({ url: "/@vite/client" } as Connect.IncomingMessage, {}, (...args: unknown[]) =>
        resolve(args),
      );
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
        named("viteTransformMiddleware", () => {
          calls.push("viteTransformMiddleware");
        }),
        passThrough("viteServeStaticMiddleware", calls),
      ],
    });

    let nextCalled = false;
    pluginMiddlewares[0]?.({ url: "/@vite/client" } as Connect.IncomingMessage, {}, () => {
      nextCalled = true;
    });

    expect(calls).toEqual(["viteTransformMiddleware"]);
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

    expect(await run()).toEqual([]);
    // Public files must keep reaching the Worker so middleware runs for them.
    expect(calls).toEqual([
      "viteTransformMiddleware",
      "viteServeRawFsMiddleware",
      "viteServeStaticMiddleware",
    ]);
  });

  it("forwards errors passed to next", async () => {
    const error = new Error("transform failed");
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [named("viteTransformMiddleware", (_req, _res, next) => next(error))],
    });

    expect(await run()).toEqual([error]);
  });

  it("forwards rejections from async middlewares", async () => {
    const error = new Error("async transform failed");
    const { run } = setup({
      enabled: true,
      viteMiddlewares: [named("viteTransformMiddleware", () => Promise.reject(error))],
    });

    expect(await run()).toEqual([error]);
  });

  it("falls through when Vite's middlewares are not found", async () => {
    const { run } = setup({ enabled: true, viteMiddlewares: [] });
    expect(await run()).toEqual([]);
  });
});
