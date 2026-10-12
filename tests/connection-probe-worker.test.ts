/**
 * Every App Router render runs its layouts and page once in a connection probe
 * (`runWithConnectionProbe`). Async work started inside the probe keeps the
 * probe's scope state alive after it returns. workerd holds every
 * AsyncLocalStorage value through a strong handle that the GC does not trace,
 * so whatever that state still references is never collected: a probe that
 * kept a pending promise whose reactions captured the request's async context
 * retained every request it ran in until the isolate ran out of heap.
 *
 * Node's AsyncLocalStorage keeps its values in GC-managed memory, so the cycle
 * is only observable on the real Workers runtime.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const CF_APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");
const CLOUDFLARE_NODE_MODULES = path.join(CF_APP_FIXTURE_DIR, "node_modules");

type CloudflarePluginFactory = (options: {
  viteEnvironment: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

type StartedWorker = {
  url: Promise<URL>;
  inspectorUrl: Promise<URL | undefined>;
  dispose(): Promise<void>;
};

/** Takes a heap snapshot through the inspector, which runs a full GC first. */
async function collectGarbage(inspectorUrl: URL): Promise<void> {
  const httpUrl = new URL(inspectorUrl);
  httpUrl.protocol = httpUrl.protocol === "wss:" ? "https:" : "http:";
  const targets = (await (await fetch(new URL("/json/list", httpUrl))).json()) as {
    webSocketDebuggerUrl?: string;
  }[];
  const debuggerUrl = targets.find((target) => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
  if (!debuggerUrl) throw new Error("No inspector target for the worker");

  // wrangler's inspector proxy only accepts DevTools connections from a local
  // origin. Node's WebSocket (undici) takes extra handshake headers here.
  const socket = new WebSocket(debuggerUrl, {
    headers: { Origin: "http://localhost" },
  } as unknown as string[]);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("error", () => reject(new Error("Inspector connection failed")));
      socket.addEventListener("close", () => reject(new Error("Inspector connection closed")));
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
        if (message.id !== 1) return;
        if (message.error) {
          reject(new Error(`Heap snapshot failed: ${JSON.stringify(message.error)}`));
        } else {
          resolve();
        }
      });
      socket.addEventListener(
        "open",
        () => socket.send(JSON.stringify({ id: 1, method: "HeapProfiler.takeHeapSnapshot" })),
        { once: true },
      );
    });
  } finally {
    socket.close();
  }
}

describe("connection probes on the Cloudflare Workers runtime", () => {
  let root = "";
  let worker: StartedWorker | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await createIsolatedFixture(
      CF_APP_FIXTURE_DIR,
      "vinext-connection-probe-worker-",
      undefined,
      CLOUDFLARE_NODE_MODULES,
    );
    // Track every request the app handles without keeping it alive.
    await fs.writeFile(
      path.join(root, "worker/index.ts"),
      `import handler from "vinext/server/fetch-handler";

const handled: WeakRef<Request>[] = [];

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> | Response {
    if (new URL(request.url).pathname === "/__retained-requests") {
      return Response.json({
        handled: handled.length,
        retained: handled.filter((ref) => ref.deref() !== undefined).length,
      });
    }
    handled.push(new WeakRef(request));
    return handler.fetch(request, env, ctx);
  },
};
`,
    );
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
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();

    const wranglerPath = path.join(root, "node_modules/wrangler/wrangler-dist/cli.js");
    const wrangler = (await import(pathToFileURL(wranglerPath).href)) as {
      unstable_startWorker(options: {
        config: string;
        dev: {
          remote: false;
          persist: false;
          logLevel: "none";
          watch: false;
          server: { port: 0 };
          inspector: { port: 0 };
        };
      }): Promise<StartedWorker>;
    };
    worker = await wrangler.unstable_startWorker({
      config: path.join(root, "dist/server/wrangler.json"),
      dev: {
        remote: false,
        persist: false,
        logLevel: "none",
        watch: false,
        server: { port: 0 },
        inspector: { port: 0 },
      },
    });
    baseUrl = (await worker.url).origin;
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("does not retain requests after rendering a page that calls connection()", async () => {
    const requests = 10;
    for (let index = 0; index < requests; index += 1) {
      // HTML requests probe the layouts, which complete. RSC requests also
      // probe the page, which suspends in connection().
      const rsc = index % 2 === 1;
      const res = await fetch(`${baseUrl}/connection-probe${rsc ? "?_rsc" : ""}`, {
        headers: rsc ? { RSC: "1" } : {},
        redirect: "manual",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(rsc ? "text/x-component" : "text/html");
      expect(await res.text()).toContain("connection-probe");
    }

    const inspectorUrl = await worker!.inspectorUrl;
    if (!inspectorUrl) throw new Error("The worker has no inspector");
    await collectGarbage(inspectorUrl);

    const { handled, retained } = (await (
      await fetch(`${baseUrl}/__retained-requests`)
    ).json()) as { handled: number; retained: number };
    expect(handled).toBe(requests);
    // workerd itself keeps the most recent request's native object alive until
    // the next request replaces it; every earlier one must be collected.
    expect(retained).toBeLessThanOrEqual(1);
  }, 60_000);
});
