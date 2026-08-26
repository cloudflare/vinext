import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CacheabilityProbeRoute } from "vinext/internal/build/prerender-paths";
import {
  cacheabilityRouteKey,
  encodeCacheabilityGeneratedPaths,
  type CacheabilityManifest,
  type CacheabilityManifestRoute,
  type CacheabilityRouteKind,
  type CacheabilityRouteState,
} from "vinext/internal/server/cacheability-manifest";
import { CACHEABILITY_DEPLOY_REQUEST_CONCURRENCY } from "vinext/internal/server/cacheability-limits";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
} from "vinext/internal/server/headers";

type ProbePayload = {
  explicitPolicyDynamicOverride?: boolean;
  kind?: CacheabilityRouteKind;
  pattern?: string;
  reason?: string;
  state?: CacheabilityRouteState;
  status?: number;
  version?: number;
};

function mergeGeneratedPaths(...groups: readonly string[][]): string[] {
  return Array.from(new Set(groups.flat())).sort();
}

function isProbeRouteKind(value: unknown): value is CacheabilityRouteKind {
  return value === "app-page" || value === "app-route" || value === "pages-page";
}

export type CacheabilityProbeResult = {
  failures: string[];
  identityProbed: number;
  manifest: CacheabilityManifest;
  probed: number;
  /** Successful public-path resolutions used only to build the final warm plan. */
  resolutions: CacheabilityProbeResolution[];
};

export type CacheabilityProbeResolution = {
  exactPath: string;
  relatedPaths?: string[];
  kind: CacheabilityRouteKind;
  pattern: string;
  sourceKind: CacheabilityRouteKind;
  sourcePattern: string;
  state: "dynamic" | "static-candidate";
};

function manifestLocation(
  route: CacheabilityProbeRoute,
  exactPath: string | undefined,
): { key: string; path?: string } {
  // A fixed route has no sibling params, so its pattern entry can hold the
  // observed result directly. Dynamic and localized/basePath variants retain
  // sparse exact entries plus a runtime-check pattern fallback.
  if (
    exactPath !== undefined &&
    route.path === route.pattern &&
    route.probePath === route.pattern
  ) {
    return { key: cacheabilityRouteKey(route.kind, route.pattern) };
  }
  return {
    key: cacheabilityRouteKey(route.kind, route.pattern, exactPath),
    ...(exactPath === undefined ? {} : { path: exactPath }),
  };
}

function readPrerenderSecret(root: string): string {
  const manifestPath = path.join(root, "dist", "server", "vinext-server.json");
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
  const secret =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).prerenderSecret
      : undefined;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(
      "Cannot probe staged Worker cacheability because dist/server/vinext-server.json does not contain a prerender secret. Rebuild the app before deploying.",
    );
  }
  return secret;
}

export function buildCacheabilityWarmHeaders(root: string, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set(VINEXT_CACHEABILITY_PROBE_HEADER, "warm");
  result.set(VINEXT_PRERENDER_SECRET_HEADER, readPrerenderSecret(root));
  return result;
}

async function probeRoute(options: {
  headers?: HeadersInit;
  route: CacheabilityProbeRoute;
  secret: string;
  targetUrl: string;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  mode?: "full" | "identity";
}): Promise<ProbePayload> {
  if (!options.route.probePath) {
    return {
      kind: options.route.kind,
      pattern: options.route.pattern,
      state: options.route.fallbackState ?? "runtime-check",
      version: 1,
    };
  }
  const headers = new Headers(options.headers);
  headers.set("Accept", options.route.kind === "app-route" ? "*/*" : "text/html");
  headers.set("Cache-Control", "no-cache");
  headers.set(VINEXT_CACHEABILITY_PROBE_HEADER, options.mode === "identity" ? "identity" : "1");
  headers.set(VINEXT_PRERENDER_SECRET_HEADER, options.secret);
  let failureReason = "probe failed";
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    let transient = true;
    try {
      const response = await fetch(new URL(options.route.probePath, options.targetUrl), {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.ok) {
        try {
          return JSON.parse(text) as ProbePayload;
        } catch {
          return { reason: "probe returned invalid JSON", state: "probe-failed", version: 1 };
        }
      }
      failureReason = `probe returned HTTP ${response.status}`;
      // These are the transient responses used by staged routing propagation
      // and vinext's expected-version guard. A user route's own 5xx response is
      // returned inside a successful authenticated probe envelope instead.
      transient = response.status === 404 || response.status === 503;
    } catch (error) {
      failureReason =
        error instanceof Error && error.name === "AbortError"
          ? `probe timed out after ${options.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      clearTimeout(timeout);
    }
    if (!transient || attempt === options.retries) break;
    if (options.retryDelayMs > 0) await delay(options.retryDelayMs);
  }
  return { reason: failureReason, state: "probe-failed", version: 1 };
}

async function resolveProbeRouteIdentityGroups(options: {
  concurrency: number;
  headers?: HeadersInit;
  retries: number;
  retryDelayMs: number;
  routes: readonly CacheabilityProbeRoute[];
  secret: string;
  targetUrl: string;
  timeoutMs: number;
}): Promise<{ failures: string[]; identityProbed: number; routes: CacheabilityProbeRoute[] }> {
  const passthrough: CacheabilityProbeRoute[] = [];
  const tasks: Array<{ route: CacheabilityProbeRoute; path: string }> = [];
  for (const route of options.routes) {
    if (!route.probePath || !route.probeGroupPaths?.length) {
      passthrough.push(route);
      continue;
    }
    for (const path of [route.probePath, ...route.probeGroupPaths]) tasks.push({ route, path });
  }
  if (tasks.length === 0) return { failures: [], identityProbed: 0, routes: passthrough };

  const failures: string[] = [];
  const grouped = new Map<
    CacheabilityProbeRoute,
    Map<string, { kind: CacheabilityRouteKind; paths: string[]; pattern: string }>
  >();
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex++];
      const result = await probeRoute({
        headers: options.headers,
        mode: "identity",
        retries: options.retries,
        retryDelayMs: options.retryDelayMs,
        route: { ...task.route, probePath: task.path },
        secret: options.secret,
        targetUrl: options.targetUrl,
        timeoutMs: options.timeoutMs,
      });
      if (
        result.version !== 1 ||
        !isProbeRouteKind(result.kind) ||
        typeof result.pattern !== "string" ||
        !result.pattern.startsWith("/")
      ) {
        failures.push(
          `${task.route.kind}:${task.route.pattern}:${task.path}: staged route identity probe failed (${result.reason ?? "invalid route identity"})`,
        );
        continue;
      }
      const routeGroups = grouped.get(task.route) ?? new Map();
      grouped.set(task.route, routeGroups);
      const key = `${result.kind}:${result.pattern}`;
      const group = routeGroups.get(key) ?? {
        kind: result.kind,
        paths: [],
        pattern: result.pattern,
      };
      group.paths.push(task.path);
      routeGroups.set(key, group);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(options.concurrency, tasks.length)) }, () =>
      worker(),
    ),
  );

  const routes = [...passthrough];
  for (const [sourceRoute, routeGroups] of grouped) {
    for (const group of routeGroups.values()) {
      const [probePath, ...relatedPaths] = group.paths;
      routes.push({
        ...sourceRoute,
        path: probePath,
        probeGroupPaths: relatedPaths,
        probePath,
        runtimeCheckWarmPaths: relatedPaths,
        warmPaths: [probePath],
      });
    }
  }
  return { failures, identityProbed: tasks.length, routes };
}

export async function probeStagedWorkerCacheability(options: {
  buildId?: string;
  concurrency?: number;
  headers?: HeadersInit;
  root: string;
  routes: readonly CacheabilityProbeRoute[];
  targetUrl: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}): Promise<CacheabilityProbeResult> {
  const secret = readPrerenderSecret(options.root);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = Math.max(0, options.retries ?? 0);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
  const concurrency = Math.max(1, options.concurrency ?? 25);
  const identityGroups = await resolveProbeRouteIdentityGroups({
    concurrency,
    headers: options.headers,
    retries,
    retryDelayMs,
    routes: options.routes,
    secret,
    targetUrl: options.targetUrl,
    timeoutMs,
  });
  const probeRoutes = identityGroups.routes;
  const routes: Record<string, CacheabilityManifestRoute> = {};
  const failures: string[] = [...identityGroups.failures];
  const resolutions: CacheabilityProbeResolution[] = [];
  let probed = 0;
  let nextIndex = 0;

  for (const route of probeRoutes) {
    const patternKey = cacheabilityRouteKey(route.kind, route.pattern);
    if (!routes[patternKey]) {
      routes[patternKey] = {
        kind: route.kind,
        pattern: route.pattern,
        // An exact-path classification must never certify sibling params.
        // The pattern entry remains the runtime fallback for every unprobed
        // path. Explicit unpathed routes (for example known Pages SSR) may
        // conservatively make the whole pattern dynamic.
        state:
          route.path === undefined ? (route.fallbackState ?? "runtime-check") : "runtime-check",
      };
    } else if (route.path === undefined && route.fallbackState === "dynamic") {
      routes[patternKey].state = "dynamic";
    }
    const generatedSiblingPaths = [
      ...(route.runtimeCheckWarmPaths ?? []),
      ...(route.probeGroupPaths ?? []),
    ];
    if (generatedSiblingPaths.length > 0) {
      routes[patternKey].generatedPaths = mergeGeneratedPaths(
        Array.isArray(routes[patternKey].generatedPaths) ? routes[patternKey].generatedPaths : [],
        generatedSiblingPaths,
      );
    }

    const exactPath = route.path ?? route.probePath;
    if (exactPath) {
      const location = manifestLocation(route, exactPath);
      routes[location.key] = {
        ...(location.path ? { generatedPath: true } : {}),
        kind: route.kind,
        ...(location.path ? { path: location.path } : {}),
        pattern: route.pattern,
        state: route.fallbackState ?? "runtime-check",
      };
    }
  }

  const worker = async (): Promise<void> => {
    while (nextIndex < probeRoutes.length) {
      const route = probeRoutes[nextIndex++];
      if (!route.probePath) continue;
      probed += 1;
      const result = await probeRoute({
        headers: options.headers,
        route,
        secret,
        targetUrl: options.targetUrl,
        timeoutMs,
        retries,
        retryDelayMs,
      });
      const exactPath = route.path ?? route.probePath;
      const location = manifestLocation(route, exactPath);
      const key = location.key;
      const integrityFailure =
        result.version !== 1 ||
        !isProbeRouteKind(result.kind) ||
        typeof result.pattern !== "string" ||
        !result.pattern.startsWith("/");
      const state = integrityFailure ? "probe-failed" : result.state;
      if (state !== "static-candidate" && state !== "dynamic") {
        const reason = integrityFailure
          ? `probe returned an invalid route identity (${String(result.kind)}:${String(result.pattern)})`
          : (result.reason ?? "probe failed without a reason");
        routes[key] = {
          kind: route.kind,
          ...(location.path ? { path: location.path } : {}),
          pattern: route.pattern,
          state: "probe-failed",
        };
        failures.push(`${key}: ${reason}`);
        continue;
      }
      routes[key] = {
        ...(result.explicitPolicyDynamicOverride === true
          ? { explicitPolicyDynamicOverride: true }
          : {}),
        ...(location.path ? { generatedPath: true } : {}),
        kind: route.kind,
        ...(location.path ? { path: location.path } : {}),
        pattern: route.pattern,
        state,
      };
      resolutions.push({
        exactPath: exactPath!,
        ...(route.probeGroupPaths?.length ? { relatedPaths: route.probeGroupPaths } : {}),
        kind: result.kind!,
        pattern: result.pattern!,
        sourceKind: route.kind,
        sourcePattern: route.pattern,
        state,
      });
      // A deterministic rewrite can make the public probe path resolve to a
      // different filesystem route. Retain the source-key copy for deploy
      // planning, and certify the resolved identity that the final Worker will
      // look up while serving that same public path.
      if (result.kind !== route.kind || result.pattern !== route.pattern) {
        const resolvedKey = cacheabilityRouteKey(result.kind!, result.pattern!, exactPath);
        routes[resolvedKey] = {
          ...(result.explicitPolicyDynamicOverride === true
            ? { explicitPolicyDynamicOverride: true }
            : {}),
          generatedPath: true,
          kind: result.kind!,
          path: exactPath,
          pattern: result.pattern!,
          state,
        };
      }
      if (route.probeGroupPaths?.length) {
        const resolvedPatternKey = cacheabilityRouteKey(result.kind!, result.pattern!);
        const resolvedPatternRoute = (routes[resolvedPatternKey] ??= {
          kind: result.kind!,
          pattern: result.pattern!,
          state: "runtime-check",
        });
        resolvedPatternRoute.generatedPaths = mergeGeneratedPaths(
          Array.isArray(resolvedPatternRoute.generatedPaths)
            ? resolvedPatternRoute.generatedPaths
            : [],
          route.probeGroupPaths,
        );
      }
    }
  };

  // Do not consume the Worker's bounded waiter queue as deploy throughput.
  // Every full probe can need the maximum artifact budget, so limit ingress to
  // the number of captures that can actively make progress in one isolate.
  const fullProbeConcurrency = Math.max(
    1,
    Math.min(concurrency, CACHEABILITY_DEPLOY_REQUEST_CONCURRENCY, probeRoutes.length || 1),
  );
  await Promise.all(Array.from({ length: fullProbeConcurrency }, () => worker()));

  for (const route of Object.values(routes)) {
    if (Array.isArray(route.generatedPaths)) {
      route.generatedPaths = encodeCacheabilityGeneratedPaths(route.generatedPaths);
    }
  }

  return {
    failures,
    identityProbed: identityGroups.identityProbed,
    manifest: {
      ...(options.buildId ? { buildId: options.buildId } : {}),
      routes,
      version: 1,
    },
    probed,
    resolutions: resolutions.sort((a, b) =>
      `${a.sourceKind}:${a.sourcePattern}:${a.exactPath}`.localeCompare(
        `${b.sourceKind}:${b.sourcePattern}:${b.exactPath}`,
      ),
    ),
  };
}
