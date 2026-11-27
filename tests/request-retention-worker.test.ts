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
 * The issue also reported a cycle through the request trace store, whose
 * `recordError`/`setRoute` closures share a scope with the request's
 * `Response`. A streamed response is rewrapped outside the store's frame, but a
 * fully buffered one is not, so the metadata route case checks that path.
 *
 * Counts the request contexts (the objects that own a
 * `currentFetchDedupeEntries` property) and the request trace stores (those
 * that own `setRoute`) alive in the isolate through an inspector heap snapshot.
 * The worker bundles vinext's `dist`, so rebuild it after changing the source.
 * Node's AsyncLocalStorage keeps its values in GC-managed memory, so the cycle
 * is only observable on the real Workers runtime.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startWorkerdWorker, type WorkerdWorker } from "./helpers.js";

const CF_APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/cf-app-basic");
const CLOUDFLARE_NODE_MODULES = path.join(CF_APP_FIXTURE_DIR, "node_modules");

type CloudflarePluginFactory = (options: {
  viteEnvironment: { name: string; childEnvironments: string[] };
}) => import("vite").Plugin;

/**
 * Takes a heap snapshot through the inspector (which runs a full GC first) and
 * counts the objects that own a property with the given name.
 */
async function countObjectsWithProperties<const P extends string>(
  inspectorUrl: URL,
  properties: readonly P[],
): Promise<Record<P, number>> {
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
  const counts = Object.fromEntries(properties.map((property) => [property, 0])) as Record<
    P,
    number
  >;
  const propertyByName = new Map<number, P>();
  for (const property of properties) {
    const nameIndex = snapshot.strings.indexOf(property);
    if (nameIndex !== -1) propertyByName.set(nameIndex, property);
  }
  let edge = 0;
  for (let node = 0; node < snapshot.nodes.length; node += nodeSize) {
    const edgeCount = snapshot.nodes[node + edgeCountOffset];
    const owned = new Set<P>();
    for (let i = 0; i < edgeCount; i++, edge += edgeSize) {
      if (snapshot.edges[edge + edgeTypeOffset] !== propertyType) continue;
      const property = propertyByName.get(snapshot.edges[edge + edgeNameOffset]);
      if (property) owned.add(property);
    }
    for (const property of owned) counts[property] += 1;
  }
  return counts;
}

// Unified request contexts own `currentFetchDedupeEntries`; request trace
// stores (`traceFrameworkRequest`, `captureFrameworkRequestRoute`) own
// `setRoute`.
const RETAINED_PROPERTIES = ["currentFetchDedupeEntries", "setRoute"] as const;
type Retained = Record<(typeof RETAINED_PROPERTIES)[number], number>;

describe("request contexts on the Cloudflare Workers runtime (#4940)", () => {
  let root = "";
  let worker: WorkerdWorker | undefined;
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

    worker = await startWorkerdWorker(root, path.join(root, "dist/server/wrangler.json"), {
      inspector: true,
    });
    baseUrl = worker.baseUrl;
  }, 180_000);

  afterAll(async () => {
    await worker?.teardown();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  function retained(): Promise<Retained> {
    return countObjectsWithProperties(worker!.inspectorUrl!, RETAINED_PROPERTIES);
  }

  async function retainedGainedBy(
    requests: number,
    init: () => [string, RequestInit],
    consume: (res: Response) => Promise<unknown>,
  ): Promise<Retained> {
    // Warm the route up so module-level state is in place before counting.
    const [warmPath, warmInit] = init();
    await consume(await fetch(`${baseUrl}${warmPath}`, warmInit));
    const before = await retained();
    for (let index = 0; index < requests; index += 1) {
      const [pathname, requestInit] = init();
      const res = await fetch(`${baseUrl}${pathname}`, { redirect: "manual", ...requestInit });
      expect(res.status).toBe(200);
      await consume(res);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await retained();
    return {
      currentFetchDedupeEntries: after.currentFetchDedupeEntries - before.currentFetchDedupeEntries,
      setRoute: after.setRoute - before.setRoute,
    };
  }

  function expectNoneRetained(gained: Retained): void {
    expect(gained.currentFetchDedupeEntries).toBeLessThanOrEqual(1);
    expect(gained.setRoute).toBeLessThanOrEqual(1);
  }

  const readAll = (res: Response) => res.text();

  it("does not keep request contexts alive after HTML requests for the home page", async () => {
    expectNoneRetained(await retainedGainedBy(20, () => ["/", {}], readAll));
  }, 120_000);

  it("does not keep request contexts alive after RSC requests for the home page", async () => {
    expectNoneRetained(
      await retainedGainedBy(20, () => ["/?_rsc", { headers: { RSC: "1" } }], readAll),
    );
  }, 120_000);

  it("does not keep request contexts alive after HTML requests for a page with deduped fetches", async () => {
    expectNoneRetained(
      await retainedGainedBy(
        20,
        () => ["/fetch-dedupe-retention", {}],
        async (res) => expect(await res.text()).toContain('<p id="second">'),
      ),
    );
  }, 120_000);

  it("does not keep request contexts alive after RSC requests for a page with deduped fetches", async () => {
    expectNoneRetained(
      await retainedGainedBy(
        20,
        () => ["/fetch-dedupe-retention?_rsc", { headers: { RSC: "1" } }],
        readAll,
      ),
    );
  }, 120_000);

  // A fully buffered response is returned as is, not rewrapped around a
  // streamed body, so the request trace's own scope still references it.
  it("does not keep request contexts alive after requests for a fully buffered metadata route", async () => {
    expectNoneRetained(
      await retainedGainedBy(
        20,
        () => ["/request-retention/sitemap.xml", {}],
        async (res) => expect(await res.text()).toContain("https://example.com/request-retention"),
      ),
    );
  }, 120_000);
});
