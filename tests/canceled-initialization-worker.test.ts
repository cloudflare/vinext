/**
 * Application initialization (`register()`, then the middleware and route
 * imports it gates) is memoized for the isolate and awaited by every request.
 * workerd binds a promise's I/O continuations to the request that started it:
 * if that request is canceled before the work settles, the continuations are
 * dropped and the promise never settles. Without keeping the creating request
 * alive, a client that aborts the first request leaves every later request in
 * the isolate waiting forever.
 *
 * Request cancellation only exists on the real Workers runtime.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const CF_APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");
const CLOUDFLARE_NODE_MODULES = path.join(CF_APP_FIXTURE_DIR, "node_modules");

type CloudflarePluginFactory = (options?: {
  viteEnvironment: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

type StartedWorker = {
  url: Promise<URL>;
  dispose(): Promise<void>;
};

type Wrangler = {
  unstable_startWorker(options: {
    config: string;
    dev: {
      remote: false;
      persist: false;
      logLevel: "none";
      watch: false;
      server: { port: 0 };
    };
  }): Promise<StartedWorker>;
};

// A client disconnect over a local socket does not cancel the request, but
// aborting a subrequest does. The Worker forwards `?cancel` to itself through
// `ctx.exports`, in the same isolate, and aborts it once register() has started.
// `/__warm` evaluates the Worker's modules without initializing the app, so the
// canceled request is the one that starts initialization.
const CANCELING_WORKER = `import handler from "vinext/server/fetch-handler";

type Ctx = ExecutionContext & {
  exports: { default: { fetch(request: Request, init?: RequestInit): Promise<Response> } };
};

export default {
  async fetch(request: Request, env: unknown, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__warm") return new Response("warm");
    if (!url.searchParams.has("cancel")) return handler.fetch(request, env, ctx);

    url.searchParams.delete("cancel");
    const controller = new AbortController();
    const abortOnceRegisterStarts = () => {
      if ((globalThis as { __registerStarted?: boolean }).__registerStarted) controller.abort();
      else setTimeout(abortOnceRegisterStarts, 10);
    };
    abortOnceRegisterStarts();
    try {
      const response = await ctx.exports.default.fetch(new Request(url, request), {
        signal: controller.signal,
      });
      await response.text();
      return new Response("completed");
    } catch (error) {
      // The abort only fires once register() has started, so this request is
      // the one that started initialization. Anything else fails the test.
      if (!controller.signal.aborted) return new Response(String(error), { status: 500 });
      return new Response("canceled");
    }
  },
};
`;

function describeCanceledInitialization(
  name: string,
  options: {
    filter?: (src: string) => boolean;
    pathname: string;
    rscEnvironment: boolean;
    /** Where @cloudflare/vite-plugin writes the Worker's generated config. */
    workerOutDir: string;
  },
): void {
  describe(name, () => {
    let root = "";
    let wrangler: Wrangler | undefined;
    let worker: StartedWorker | undefined;

    /** A fresh worker has a fresh isolate, so its first request creates the memo. */
    async function startWorker(): Promise<string> {
      worker = await wrangler!.unstable_startWorker({
        config: path.join(root, options.workerOutDir, "wrangler.json"),
        dev: {
          remote: false,
          persist: false,
          logLevel: "none",
          watch: false,
          server: { port: 0 },
        },
      });
      const origin = (await worker.url).origin;
      const warm = await fetch(`${origin}/__warm`);
      expect(await warm.text()).toBe("warm");
      return origin;
    }

    beforeAll(async () => {
      root = await createIsolatedFixture(
        CF_APP_FIXTURE_DIR,
        "vinext-canceled-initialization-worker-",
        options.filter,
        CLOUDFLARE_NODE_MODULES,
      );
      // Stands in for a register() that waits on I/O, such as fetching config.
      await fs.writeFile(
        path.join(root, "instrumentation.ts"),
        `export async function register() {
  (globalThis as { __registerStarted?: boolean }).__registerStarted = true;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
`,
      );
      await fs.writeFile(path.join(root, "worker/index.ts"), CANCELING_WORKER);
      const cloudflarePluginPath = path.join(
        root,
        "node_modules/@cloudflare/vite-plugin/dist/index.mjs",
      );
      const { cloudflare } = (await import(pathToFileURL(cloudflarePluginPath).href)) as {
        cloudflare: CloudflarePluginFactory;
      };
      const builder = await createBuilder({
        root,
        configFile: false,
        plugins: [
          vinext({ appDir: root }),
          options.rscEnvironment
            ? cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })
            : cloudflare(),
        ],
        logLevel: "silent",
      });
      await builder.buildApp();

      const wranglerPath = path.join(root, "node_modules/wrangler/wrangler-dist/cli.js");
      wrangler = (await import(pathToFileURL(wranglerPath).href)) as Wrangler;
    }, 180_000);

    afterEach(async () => {
      await worker?.dispose();
      worker = undefined;
    });

    afterAll(async () => {
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it("serves the next request after the one that started initialization is canceled", async () => {
      const baseUrl = await startWorker();
      // register() takes 1s, so the abort lands while initialization is pending.
      const first = await fetch(`${baseUrl}${options.pathname}?cancel`);
      expect(await first.text()).toBe("canceled");

      const second = await fetch(`${baseUrl}${options.pathname}`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(second.status).toBe(200);
      await second.text();
    }, 30_000);
  });
}

describeCanceledInitialization("canceled initialization: App Router on Workers", {
  pathname: "/",
  rscEnvironment: true,
  workerOutDir: "dist/server",
});

describeCanceledInitialization("canceled initialization: Pages Router on Workers", {
  // Without app/, the same fixture builds as a Pages Router app, which
  // initializes through the Pages server entry instead of the RSC entry.
  filter: (src) => !src.includes(`${path.sep}cf-app-basic${path.sep}app`),
  pathname: "/pages-home",
  rscEnvironment: false,
  workerOutDir: "dist/cf_app_basic",
});
