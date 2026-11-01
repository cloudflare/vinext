import { describe, expect, it } from "vite-plus/test";
import type {
  RouteManifest,
  RouteManifestRoute,
} from "../packages/vinext/src/routing/app-route-graph.js";
import {
  decodeBrowserRouteManifest,
  toBrowserRouteManifestWire,
} from "../packages/vinext/src/routing/browser-route-manifest.js";
import {
  buildOptimisticRouteTrie,
  matchOptimisticRouteTrie,
} from "../packages/vinext/src/routing/optimistic-route-trie.js";
import { buildRouteTrie, trieMatchRaw } from "../packages/vinext/src/routing/route-trie.js";
import { sortRoutes } from "../packages/vinext/src/routing/utils.js";
import { matchOptimisticRouteManifestRoute } from "../packages/vinext/src/server/app-optimistic-routing.js";

type TestRoute = RouteManifestRoute & { pattern: string; patternParts: string[] };

const LITERALS = ["a", "b", "c"];
// A segment no route names, standing for every other value.
const OTHER_SEGMENT = "z";

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRoute(patternParts: string[], isHandler: boolean): TestRoute {
  const pattern = `/${patternParts.join("/")}`;
  return {
    id: `route:${pattern}`,
    pattern,
    patternParts,
    isDynamic: patternParts.some((part) => part.startsWith(":")),
    paramNames: patternParts.filter((part) => part.startsWith(":")),
    rootBoundaryId: null,
    pageId: isHandler ? null : `page:${pattern}`,
    routeHandlerId: isHandler ? `route-handler:${pattern}` : null,
    layoutIds: [],
    slotIds: [],
  } as unknown as TestRoute;
}

/** A random App Router app whose routes all have distinct shapes. */
function createRandomApp(random: () => number): TestRoute[] {
  const routes = new Map<string, TestRoute>();
  const routeCount = 2 + Math.floor(random() * 7);
  while (routes.size < routeCount) {
    const length = Math.floor(random() * 4);
    const parts: string[] = [];
    for (let depth = 0; depth < length; depth++) {
      const kind = random();
      const isLast = depth === length - 1;
      // Param names follow the depth, so routes never disagree on a name.
      if (kind < 0.5) parts.push(LITERALS[Math.floor(random() * LITERALS.length)]);
      else if (kind < 0.75 || !isLast) parts.push(`:d${depth}`);
      else parts.push(kind < 0.88 ? `:c${depth}+` : `:o${depth}*`);
    }
    const pattern = `/${parts.join("/")}`;
    if (!routes.has(pattern)) routes.set(pattern, createRoute(parts, random() < 0.5));
  }
  return sortRoutes([...routes.values()]);
}

function toRouteManifest(routes: readonly TestRoute[]): RouteManifest {
  return {
    graphVersion: "graph:test",
    segmentGraph: {
      routes: new Map(routes.map((route) => [route.id, route])),
      layouts: new Map(),
      slotBindings: new Map(),
      interceptions: new Map(),
      interceptionsBySlotId: new Map(),
      rootBoundaries: new Map(),
    },
  } as unknown as RouteManifest;
}

function* urlsUpTo(maxLength: number): Generator<string[]> {
  const segments = [...LITERALS, OTHER_SEGMENT];
  let current: string[][] = [[]];
  for (let length = 0; length <= maxLength; length++) {
    yield* current;
    current = current.flatMap((url) => segments.map((segment) => [...url, segment]));
  }
}

/** The route the server picks for `url` among `routes`. */
function serverMatch(routes: readonly TestRoute[], url: string[]): TestRoute | null {
  return trieMatchRaw(buildRouteTrie(sortRoutes([...routes])), url)?.route ?? null;
}

describe("browser route manifest route handler selection (issue #3624)", () => {
  // Every URL the generated apps can tell apart: all route literals and one
  // other value, longer than any route pattern.
  const URL_MAX_LENGTH = 5;

  it("never lets the client predict a page for a URL the router sends to an omitted handler", () => {
    const random = mulberry32(3624);
    for (let app = 0; app < 300; app++) {
      const routes = createRandomApp(random);
      const browserManifest = decodeBrowserRouteManifest(
        toBrowserRouteManifestWire(toRouteManifest(routes)),
      );
      const shipped = browserManifest.segmentGraph.routes;
      for (const url of urlsUpTo(URL_MAX_LENGTH)) {
        const winner = serverMatch(routes, url);
        if (winner === null || winner.routeHandlerId === null || shipped.has(winner.id)) continue;
        const predicted = matchOptimisticRouteManifestRoute({
          basePath: "",
          href: `/${url.join("/")}`,
          routeManifest: browserManifest,
        })?.route;
        expect(
          predicted?.pageId ?? null,
          `${routes.map((route) => `${route.routeHandlerId ? "handler" : "page"} ${route.pattern}`).join(", ")}: /${url.join("/")}`,
        ).toBeNull();
      }
    }
  });

  it("ships a handler only when the client would otherwise predict a page it outranks", () => {
    const random = mulberry32(4109);
    for (let app = 0; app < 300; app++) {
      const routes = createRandomApp(random);
      const pages = routes.filter((route) => route.routeHandlerId === null);
      const pageTrie = buildOptimisticRouteTrie(pages);
      const shipped = decodeBrowserRouteManifest(
        toBrowserRouteManifestWire(toRouteManifest(routes)),
      ).segmentGraph.routes;
      for (const handler of routes.filter((route) => route.routeHandlerId !== null)) {
        let needed = false;
        for (const url of urlsUpTo(URL_MAX_LENGTH)) {
          if (serverMatch([handler], url) === null) continue;
          const page = matchOptimisticRouteTrie(pageTrie, url)?.route;
          if (page !== undefined && serverMatch([handler, page], url) === handler) {
            needed = true;
            break;
          }
        }
        expect(
          shipped.has(handler.id),
          `${routes.map((route) => `${route.routeHandlerId ? "handler" : "page"} ${route.pattern}`).join(", ")}: ${handler.pattern}`,
        ).toBe(needed);
      }
    }
  });
});
