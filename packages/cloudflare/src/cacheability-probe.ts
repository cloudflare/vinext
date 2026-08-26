import fs from "node:fs";
import path from "node:path";
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
}): Promise<ProbePayload> {
  if (!options.route.probePath) {
    return {
      kind: options.route.kind,
      pattern: options.route.pattern,
      state: "dynamic",
      version: 1,
    };
  }
  const headers = new Headers(options.headers);
  headers.set("Accept", options.route.kind === "app-route" ? "*/*" : "text/html");
  headers.set("Cache-Control", "no-cache");
  headers.set(VINEXT_CACHEABILITY_PROBE_HEADER, "1");
  headers.set(VINEXT_PRERENDER_SECRET_HEADER, options.secret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(new URL(options.route.probePath, options.targetUrl), {
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        reason: `probe returned HTTP ${response.status}`,
        state: "probe-failed",
        version: 1,
      };
    }
    try {
      return JSON.parse(text) as ProbePayload;
    } catch {
      return { reason: "probe returned invalid JSON", state: "probe-failed", version: 1 };
    }
  } catch (error) {
    return {
      reason:
        error instanceof Error && error.name === "AbortError"
          ? `probe timed out after ${options.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
      state: "probe-failed",
      version: 1,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeStagedWorkerCacheability(options: {
  buildId?: string;
  concurrency?: number;
  headers?: HeadersInit;
  root: string;
  routes: readonly CacheabilityProbeRoute[];
  targetUrl: string;
  timeoutMs?: number;
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
      state: "dynamic",
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
