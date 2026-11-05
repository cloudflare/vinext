/**
 * Worker for tests/workerd-promise-context.test.ts.
 *
 * Each scenario memoizes a load for the isolate through vinext's own code, the
 * way a production build does, with the function that creates the shared
 * promise compiled by TurboFan first. One request starts the load and settles
 * it; two others await it and then make a subrequest of their own.
 *
 * `./v8-natives.js` is passed to workerd unbundled by the test, since only V8
 * with --allow-natives-syntax can parse it.
 */
import { ensureAppRouteModulesLoaded } from "vinext/internal/server/app-route-module-loader";
import { wrapClientReferenceRequire } from "vinext/internal/server/app-streamed-client-references";
import { isolateServerReferenceLoads } from "vinext/internal/server/server-reference-loader";
// @ts-expect-error -- the test supplies this module
import { optimize, optimizationStatus } from "./v8-natives.js";

type Scenario = {
  /** Compile the function that creates the shared promise; returns its V8 status. */
  prime(): number;
  /** Start the shared load of the "gated" source; returns the creator's V8 status. */
  start(): number;
  /** The shared load, as a later request gets it, for the request to await. */
  join(): unknown;
};

// Every load in a scenario runs the same code, primed or gated, so the compiled
// code that creates the gated load is the code the priming calls compiled.
let primeCount = 0;
const sources = new Map<string, Promise<unknown>>();
function primeId(): string {
  const id = `prime-${primeCount++}`;
  sources.set(id, Promise.resolve());
  return id;
}
const loadSource = (id: string) => sources.get(id)!.then(() => ({ id }));

// --- Route modules (app-route-module-loader.ts) -----------------------------

function createRoute(id: string) {
  return {
    page: null as unknown,
    layouts: [null] as unknown[],
    __loadPage: () => loadSource(id),
    __loadLayouts: [() => Promise.resolve({ default: "layout" })],
    __loaded: false,
    __loading: null as Promise<unknown> | null,
  };
}

let gatedRoute: ReturnType<typeof createRoute> | undefined;
const routeModules: Scenario = {
  prime: () => optimize(ensureAppRouteModulesLoaded, () => [createRoute(primeId())]),
  start() {
    gatedRoute = createRoute("gated");
    void ensureAppRouteModulesLoaded(gatedRoute);
    return optimizationStatus(ensureAppRouteModulesLoaded);
  },
  join: () => ensureAppRouteModulesLoaded(gatedRoute),
};

// --- Server references (server-reference-loader.ts) -------------------------

// plugin-rsc's `memoize`, around an async loader like the one it installs.
function memoize<T>(fn: (id: string) => T): (id: string) => T {
  const cache = new Map<string, T>();
  return (id) => {
    if (cache.has(id)) return cache.get(id)!;
    const value = fn(id);
    cache.set(id, value);
    return value;
  };
}

const loadServerModule = async (id: string) => await loadSource(id);
globalThis.__vite_rsc_server_require__ = memoize(loadServerModule);
isolateServerReferenceLoads();
const serverRequire = globalThis.__vite_rsc_server_require__!;

const serverReferences: Scenario = {
  prime: () => optimize(loadServerModule, () => [primeId()]),
  start() {
    void serverRequire("gated");
    return optimizationStatus(loadServerModule);
  },
  join: () => serverRequire("gated"),
};

// --- Client references (app-streamed-client-references.ts) ------------------

globalThis.__vite_rsc_client_require__ = loadSource;
wrapClientReferenceRequire(new Set(), () => undefined);
const clientRequire = globalThis.__vite_rsc_client_require__!;

const clientReferences: Scenario = {
  prime: () => optimize(clientRequire, () => [primeId()]),
  start() {
    void clientRequire("gated");
    return optimizationStatus(clientRequire);
  },
  join: () => clientRequire("gated"),
};

// --- Requests ---------------------------------------------------------------

const scenarios: Record<string, Scenario> = { routeModules, serverReferences, clientReferences };
let started = false;
let joined = 0;

export default {
  async fetch(request: Request, env: { UPSTREAM: Fetcher }): Promise<Response> {
    const url = new URL(request.url);
    const scenario = scenarios[url.searchParams.get("scenario") ?? ""];
    if (!scenario) return new Response("unknown scenario", { status: 400 });

    switch (url.pathname) {
      case "/start": {
        started = false;
        joined = 0;
        let open!: () => void;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        sources.set("gated", gate);
        // Compile the creator and start the load in one task, before the
        // priming loads settle and change what the compiled code assumed.
        const primed = scenario.prime();
        const status = scenario.start();
        started = true;
        // Settle the load from this request once both joiners await it.
        for (let i = 0; joined < 2 && i < 500; i++) await scheduler.wait(10);
        open();
        return Response.json({ primed, status, joined });
      }
      case "/started":
        return new Response(String(started));
      case "/join": {
        joined++;
        // Pending I/O of this request's own, so workerd does not cancel it as
        // hung if its continuation runs in another request.
        void scheduler.wait(10_000);
        await scenario.join();
        // A subrequest is I/O that this request may only make from its own
        // context.
        const reply = await env.UPSTREAM.fetch("http://upstream/");
        return new Response(await reply.text());
      }
    }
    return new Response("not found", { status: 404 });
  },
};
