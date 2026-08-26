import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CacheabilityProbeRoute } from "vinext/internal/build/prerender-paths";
import {
  cacheabilityRouteKey,
  type CacheabilityManifest,
  type CacheabilityManifestRoute,
  type CacheabilityRouteKind,
  type CacheabilityRouteState,
} from "vinext/internal/server/cacheability-manifest";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
} from "vinext/internal/server/headers";

type ProbePayload = {
  kind?: CacheabilityRouteKind;
  pattern?: string;
  reason?: string;
  state?: CacheabilityRouteState;
  status?: number;
  version?: number;
};

export type CacheabilityProbeResult = {
  failures: string[];
  manifest: CacheabilityManifest;
  probed: number;
};

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

async function probeRoute(options: {
  headers?: HeadersInit;
  route: CacheabilityProbeRoute;
  secret: string;
  targetUrl: string;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
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
  headers.set(VINEXT_CACHEABILITY_PROBE_HEADER, "1");
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
  const routes: Record<string, CacheabilityManifestRoute> = {};
  const failures: string[] = [];
  let probed = 0;
  let nextIndex = 0;

  for (const route of options.routes) {
    routes[cacheabilityRouteKey(route.kind, route.pattern)] = {
      kind: route.kind,
      pattern: route.pattern,
      state: route.fallbackState ?? "runtime-check",
    };
  }

  const worker = async (): Promise<void> => {
    while (nextIndex < options.routes.length) {
      const route = options.routes[nextIndex++];
      if (!route.probePath) continue;
      probed += 1;
      const result = await probeRoute({
        headers: options.headers,
        route,
        secret,
        targetUrl: options.targetUrl,
        timeoutMs: options.timeoutMs ?? 30_000,
        retries: Math.max(0, options.retries ?? 0),
        retryDelayMs: Math.max(0, options.retryDelayMs ?? 0),
      });
      const key = cacheabilityRouteKey(route.kind, route.pattern);
      const integrityFailure =
        result.version !== 1 || result.kind !== route.kind || result.pattern !== route.pattern;
      const state = integrityFailure ? "probe-failed" : result.state;
      if (state !== "static-candidate" && state !== "dynamic") {
        const reason = integrityFailure
          ? `probe identity mismatch (expected ${key}, received ${String(result.kind)}:${String(result.pattern)})`
          : (result.reason ?? "probe failed without a reason");
        routes[key] = { kind: route.kind, pattern: route.pattern, state: "probe-failed" };
        failures.push(`${key}: ${reason}`);
        continue;
      }
      routes[key] = { kind: route.kind, pattern: route.pattern, state };
    }
  };

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 25, options.routes.length || 1));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    failures,
    manifest: {
      ...(options.buildId ? { buildId: options.buildId } : {}),
      routes,
      version: 1,
    },
    probed,
  };
}
