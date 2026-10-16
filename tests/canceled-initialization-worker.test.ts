/**
 * Application initialization (`register()`, then the middleware and route
 * imports it gates) is memoized for the isolate and awaited by every request,
 * and so is the server `React.lazy` that each `next/dynamic` call creates.
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
// `ctx.exports`, in the same isolate, and aborts it once the shared work has
// started. `/__warm` evaluates the Worker's modules without rendering anything,
// so the canceled request is the one that starts the shared work.
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
    const abortOnceSharedWorkStarts = () => {
      if ((globalThis as { __sharedWorkStarted?: boolean }).__sharedWorkStarted) controller.abort();
      else setTimeout(abortOnceSharedWorkStarts, 10);
    };
    abortOnceSharedWorkStarts();
    try {
      const response = await ctx.exports.default.fetch(new Request(url, request), {
        signal: controller.signal,
      });
      await response.text();
      return new Response("completed");
    } catch (error) {
      // The abort only fires once the shared work has started, so this request
      // is the one that started it. Anything else fails the test.
      if (!controller.signal.aborted) return new Response(String(error), { status: 500 });
      return new Response("canceled");
    }
  },
};
`;

// Stands in for a loader that waits on I/O, such as fetching data.
const SLOW_DYNAMIC = `import dynamic from "next/dynamic";

export const Slow = dynamic(async () => {
  (globalThis as { __sharedWorkStarted?: boolean }).__sharedWorkStarted = true;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return function SlowContent() {
    return <p>slow</p>;
  };
});
`;

const SLOW_DYNAMIC_PAGE = `import { Slow } from "./slow-dynamic";

export default function Page() {
  return <Slow />;
}
`;

function describeCanceledSharedWork(
  name: string,
  options: {
    /** Files written into the fixture to start the shared work. */
    files: Record<string, string>;
    filter?: (src: string) => boolean;
    pathname: string;
    /** Text the next response must render. */
    text: string;
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
      for (const [file, contents] of Object.entries(options.files)) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(path.join(root, file), contents);
      }
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

    it("serves the next request after the one that started the shared work is canceled", async () => {
      const baseUrl = await startWorker();
      // The shared work takes 1s, so the abort lands while it is pending.
      const first = await fetch(`${baseUrl}${options.pathname}?cancel`);
      expect(await first.text()).toBe("canceled");

      const second = await fetch(`${baseUrl}${options.pathname}`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(second.status).toBe(200);
      expect(await second.text()).toContain(options.text);
    }, 30_000);
  });
}

// Stands in for a register() that waits on I/O, such as fetching config.
const SLOW_INSTRUMENTATION = {
  "instrumentation.ts": `export async function register() {
  (globalThis as { __sharedWorkStarted?: boolean }).__sharedWorkStarted = true;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
`,
};

// Without app/, the same fixture builds as a Pages Router app, which renders
// through the Pages server entry instead of the RSC entry.
const pagesRouterOnly = (src: string) => !src.includes(`${path.sep}cf-app-basic${path.sep}app`);

describeCanceledSharedWork("canceled initialization: App Router on Workers", {
  files: SLOW_INSTRUMENTATION,
  pathname: "/",
  text: "<h1>Home</h1>",
  rscEnvironment: true,
  workerOutDir: "dist/server",
});

describeCanceledSharedWork("canceled initialization: Pages Router on Workers", {
  files: SLOW_INSTRUMENTATION,
  filter: pagesRouterOnly,
  pathname: "/pages-home",
  text: "CF Hybrid Home (Pages)",
  rscEnvironment: false,
  workerOutDir: "dist/cf_app_basic",
});

describeCanceledSharedWork("canceled next/dynamic: App Router server component on Workers", {
  files: {
    "app/slow-dynamic/slow-dynamic.tsx": SLOW_DYNAMIC,
    "app/slow-dynamic/page.tsx": SLOW_DYNAMIC_PAGE,
  },
  pathname: "/slow-dynamic",
  text: "<p>slow</p>",
  rscEnvironment: true,
  workerOutDir: "dist/server",
});

describeCanceledSharedWork("canceled next/dynamic: App Router client component on Workers", {
  files: {
    "app/slow-dynamic/slow-dynamic.tsx": `"use client";\n${SLOW_DYNAMIC}`,
    "app/slow-dynamic/page.tsx": SLOW_DYNAMIC_PAGE,
  },
  pathname: "/slow-dynamic",
  text: "<p>slow</p>",
  rscEnvironment: true,
  workerOutDir: "dist/server",
});

describeCanceledSharedWork("canceled next/dynamic: Pages Router on Workers", {
  files: {
    "components/slow-dynamic.tsx": SLOW_DYNAMIC,
    "pages/slow-dynamic.tsx": SLOW_DYNAMIC_PAGE.replace(
      "./slow-dynamic",
      "../components/slow-dynamic",
    ),
  },
  filter: pagesRouterOnly,
  pathname: "/slow-dynamic",
  text: "<p>slow</p>",
  rscEnvironment: false,
  workerOutDir: "dist/cf_app_basic",
});
