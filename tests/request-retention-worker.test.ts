/**
 * Issue #4940. workerd holds every AsyncLocalStorage value through a strong
 * handle from each async context frame that carries it, and a ReadableStream
 * created in a request keeps that request's frame. A request context that
 * still references such a stream after the response is done forms a cycle the
 * GC can't collect, keeping the request alive for the life of the isolate.
 *
 * The fetch dedupe map on the request context keeps the unread tee branch of
 * every deduped fetch response (`entry.response`), and nothing clears it once
 * the response has been sent, so each render that fetches is retained.
 *
 * Counts the request contexts alive in the isolate (the objects that own a
 * `currentFetchDedupeEntries` property) through an inspector heap snapshot.
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

/**
 * Takes a heap snapshot through the inspector (which runs a full GC first) and
 * counts the objects that own a property with the given name.
 */
async function countObjectsWithProperty(inspectorUrl: URL, property: string): Promise<number> {
  const httpUrl = new URL(inspectorUrl);
  httpUrl.protocol = httpUrl.protocol === "wss:" ? "https:" : "http:";
  const targets = (await (await fetch(new URL("/json/list", httpUrl))).json()) as {
    webSocketDebuggerUrl?: string;
  }[];
  const debuggerUrl = targets.find((target) => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
  if (!debuggerUrl) throw new Error("No inspector target for the worker");

  const socket = new WebSocket(debuggerUrl, {
    headers: { Origin: "http://localhost" },
  } as unknown as string[]);
  const chunks: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("error", () => reject(new Error("Inspector connection failed")));
      socket.addEventListener("close", () => reject(new Error("Inspector connection closed")));
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          error?: unknown;
          method?: string;
          params?: { chunk: string };
        };
        if (message.method === "HeapProfiler.addHeapSnapshotChunk") {
          chunks.push(message.params!.chunk);
          return;
        }
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

  const snapshot = JSON.parse(chunks.join("")) as {
    snapshot: {
      meta: { node_fields: string[]; edge_fields: string[]; edge_types: [string[]] };
    };
    nodes: number[];
    edges: number[];
    strings: string[];
  };
  const { node_fields, edge_fields, edge_types } = snapshot.snapshot.meta;
  const nodeSize = node_fields.length;
  const edgeSize = edge_fields.length;
  const edgeCountOffset = node_fields.indexOf("edge_count");
  const edgeTypeOffset = edge_fields.indexOf("type");
  const edgeNameOffset = edge_fields.indexOf("name_or_index");
  const propertyType = edge_types[0].indexOf("property");
  const nameIndex = snapshot.strings.indexOf(property);
  if (nameIndex === -1) return 0;
  let count = 0;
  let edge = 0;
  for (let node = 0; node < snapshot.nodes.length; node += nodeSize) {
    const edgeCount = snapshot.nodes[node + edgeCountOffset];
    let owns = false;
    for (let i = 0; i < edgeCount; i++, edge += edgeSize) {
      if (
        snapshot.edges[edge + edgeTypeOffset] === propertyType &&
        snapshot.edges[edge + edgeNameOffset] === nameIndex
      ) {
        owns = true;
      }
    }
    if (owns) count++;
  }
  return count;
}

describe("request contexts on the Cloudflare Workers runtime (#4940)", () => {
  let root = "";
  let worker: StartedWorker | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await createIsolatedFixture(
      CF_APP_FIXTURE_DIR,
      "vinext-request-retention-worker-",
      undefined,
      CLOUDFLARE_NODE_MODULES,
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
          server: { hostname: string; port: 0 };
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
        server: { hostname: "127.0.0.1", port: 0 },
        inspector: { port: 0 },
      },
    });
    baseUrl = (await worker.url).origin;
  }, 180_000);

  afterAll(async () => {
    await worker?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function contexts(): Promise<number> {
    const inspectorUrl = await worker!.inspectorUrl;
    if (!inspectorUrl) throw new Error("The worker has no inspector");
    return countObjectsWithProperty(inspectorUrl, "currentFetchDedupeEntries");
  }

  async function contextsGainedBy(
    requests: number,
    init: () => [string, RequestInit],
    consume: (res: Response) => Promise<unknown>,
  ): Promise<number> {
    // Warm the route up so module-level state is in place before counting.
    const [warmPath, warmInit] = init();
    await consume(await fetch(`${baseUrl}${warmPath}`, warmInit));
    const before = await contexts();
    for (let index = 0; index < requests; index += 1) {
      const [pathname, requestInit] = init();
      const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual", ...requestInit });
      expect(res.status).toBe(200);
      await consume(res);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return (await contexts()) - before;
  }

  const readAll = (res: Response) => res.text();

  it("does not keep request contexts alive after HTML requests for the home page", async () => {
    expect(await contextsGainedBy(20, () => ["/", {}], readAll)).toBeLessThanOrEqual(1);
  }, 120_000);

  it("does not keep request contexts alive after RSC requests for the home page", async () => {
    expect(
      await contextsGainedBy(20, () => ["/?_rsc", { headers: { RSC: "1" } }], readAll),
    ).toBeLessThanOrEqual(1);
  }, 120_000);

  it("does not keep request contexts alive after HTML requests for a page with deduped fetches", async () => {
    expect(
      await contextsGainedBy(
        20,
        () => ["/fetch-dedupe-retention", {}],
        async (res) => expect(await res.text()).toContain('<p id="second">'),
      ),
    ).toBeLessThanOrEqual(1);
  }, 120_000);

  it("does not keep request contexts alive after RSC requests for a page with deduped fetches", async () => {
    expect(
      await contextsGainedBy(
        20,
        () => ["/fetch-dedupe-retention?_rsc", { headers: { RSC: "1" } }],
        readAll,
      ),
    ).toBeLessThanOrEqual(1);
  }, 120_000);
});
