import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  cacheabilityManifestRouteKey,
  cacheabilityRequestIdentity,
  type CacheabilityManifest,
  type CacheabilityManifestRoute,
} from "vinext/internal/server/cacheability-manifest";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_CACHEABILITY_PROBE_QUERY_PARAM,
  VINEXT_PRERENDER_SECRET_HEADER,
} from "vinext/internal/server/headers";
import { VINEXT_CDN_BUILD_ID_HEADER } from "./cache/cdn-build-id.js";
import type { CdnWarmTarget } from "./cdn-warm.js";

type ProbePayload = {
  kind?: string;
  pattern?: string;
  reason?: string;
  state?: string;
  status?: number;
  version?: number;
};

export type CacheabilityProbeResult = {
  cacheableTargets: CdnWarmTarget[];
  failures: string[];
  manifest: CacheabilityManifest;
  probed: number;
};

function isProbeRouteState(value: unknown): value is CacheabilityManifestRoute["state"] {
  return value === "static-candidate" || value === "dynamic" || value === "probe-failed";
}

function readPrerenderSecret(root: string): string {
  const manifestPath = path.join(root, "dist", "server", "vinext-server.json");
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
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

async function probeTarget(options: {
  expectedBuildId?: string;
  fetchImpl: typeof fetch;
  headers?: HeadersInit;
  retries: number;
  retryDelayMs: number;
  secret: string;
  target: CdnWarmTarget;
  targetUrl: string;
  timeoutMs: number;
}): Promise<ProbePayload> {
  const headers = new Headers(options.headers);
  for (const [name, value] of new Headers(options.target.headers)) headers.set(name, value);
  headers.set("Cache-Control", "no-cache");
  headers.set(VINEXT_CACHEABILITY_PROBE_HEADER, "1");
  headers.set(VINEXT_PRERENDER_SECRET_HEADER, options.secret);

  let reason = "probe failed";
  const probeId = randomUUID();
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    let retryable = true;
    try {
      const url = new URL(options.target.pathname, options.targetUrl);
      url.searchParams.set(VINEXT_CACHEABILITY_PROBE_QUERY_PARAM, `${probeId}-${attempt}`);
      const response = await options.fetchImpl(url, {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (
        options.expectedBuildId !== undefined &&
        response.headers.get(VINEXT_CDN_BUILD_ID_HEADER) !== options.expectedBuildId
      ) {
        await response.body?.cancel().catch(() => {});
        reason = "probe reached an unexpected Worker build";
        retryable = true;
      } else if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        reason = `probe returned HTTP ${response.status}`;
        retryable = response.status === 404 || response.status === 503;
      } else {
        const text = await response.text();
        try {
          return JSON.parse(text) as ProbePayload;
        } catch {
          return { reason: "probe returned invalid JSON", state: "probe-failed", version: 1 };
        }
      }
    } catch (error) {
      reason =
        error instanceof Error && error.name === "AbortError"
          ? `probe timed out after ${options.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      clearTimeout(timeout);
    }
    if (!retryable || attempt === options.retries) break;
    if (options.retryDelayMs > 0) await delay(options.retryDelayMs);
  }
  return { reason, state: "probe-failed", version: 1 };
}

export async function probeStagedWorkerCacheability(options: {
  buildId: string;
  concurrency?: number;
  expectedResponseBuildId?: string;
  fetchImpl?: typeof fetch;
  headers?: HeadersInit;
  retries?: number;
  retryDelayMs?: number;
  root: string;
  targets: readonly CdnWarmTarget[];
  targetUrl: string;
  timeoutMs?: number;
}): Promise<CacheabilityProbeResult> {
  const secret = readPrerenderSecret(options.root);
  const concurrency = Math.max(1, options.concurrency ?? 25);
  const retries = Math.max(0, options.retries ?? 2);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const routes: Record<string, CacheabilityManifestRoute> = {};
  const cacheableTargets: CdnWarmTarget[] = [];
  const failures: string[] = [];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < options.targets.length) {
      const target = options.targets[nextIndex++];
      const request = new Request(new URL(target.pathname, options.targetUrl), {
        headers: target.headers,
      });
      const identity = cacheabilityRequestIdentity(request);
      if (!identity || identity.representation !== target.kind) {
        failures.push(`${target.label}: warm request does not have a cacheable request identity`);
        continue;
      }

      const result = await probeTarget({
        expectedBuildId: options.expectedResponseBuildId,
        fetchImpl: options.fetchImpl ?? fetch,
        headers: options.headers,
        retries,
        retryDelayMs,
        secret,
        target,
        targetUrl: options.targetUrl,
        timeoutMs,
      });
      if (
        result.version !== 1 ||
        result.kind !== "app-page" ||
        typeof result.pattern !== "string" ||
        !result.pattern.startsWith("/") ||
        !isProbeRouteState(result.state) ||
        !Number.isInteger(result.status) ||
        result.status! < 100 ||
        result.status! > 599
      ) {
        failures.push(`${target.label}: ${result.reason ?? "probe returned an invalid envelope"}`);
        continue;
      }
      if (result.state === "probe-failed") {
        failures.push(`${target.label}: ${result.reason ?? "probe failed"}`);
      }

      // Dynamic identities are represented by absence. The runtime treats a
      // missing exact identity as private, which keeps the deployed asset small
      // and prevents the final warm/certification pass from rendering it again.
      if (result.state !== "static-candidate") continue;

      const route: CacheabilityManifestRoute = {
        kind: "app-page",
        pattern: result.pattern,
        representation: identity.representation,
        requestKey: identity.requestKey,
        state: result.state,
        status: result.status!,
      };
      routes[
        cacheabilityManifestRouteKey(
          route.kind,
          route.pattern,
          route.representation,
          route.requestKey,
        )
      ] = route;
      cacheableTargets.push(target);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, options.targets.length) }, () => worker()),
  );
  const sortedRoutes = Object.fromEntries(
    Object.entries(routes).sort(([first], [second]) => first.localeCompare(second)),
  );
  cacheableTargets.sort((first, second) =>
    `${first.kind}\0${first.sourcePathname}`.localeCompare(
      `${second.kind}\0${second.sourcePathname}`,
    ),
  );
  return {
    cacheableTargets,
    failures,
    manifest: { buildId: options.buildId, routes: sortedRoutes, version: 1 },
    probed: options.targets.length,
  };
}
