import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
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
import {
  cacheabilityManifestByteLimitError,
  cacheabilityManifestRouteLimitError,
  MAX_CACHEABILITY_MANIFEST_BYTES,
  MAX_CACHEABILITY_MANIFEST_ROUTES,
} from "./cacheability-manifest-limits.js";

export const DEFAULT_CACHEABILITY_PROBE_PHASE_TIMEOUT_MS = 120_000;
export const DEFAULT_CACHEABILITY_PROBE_RETRIES = 2;
export const DEFAULT_CACHEABILITY_PROBE_RETRY_DELAY_MS = 1_000;
const DEFAULT_CACHEABILITY_PROBE_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CACHEABILITY_PROBE_ENVELOPE_BYTES = 64 * 1024;

type ProbePayload = {
  kind?: string;
  pattern?: string;
  reason?: string;
  state?: string;
  status?: number;
  version?: number;
  phaseTimedOut?: boolean;
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

async function readProbeEnvelope(response: Response): Promise<ProbePayload> {
  if (!response.body) {
    return { reason: "probe returned invalid JSON", state: "probe-failed", version: 1 };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_CACHEABILITY_PROBE_ENVELOPE_BYTES) {
        await reader.cancel().catch(() => {});
        return {
          reason: `probe response exceeded ${MAX_CACHEABILITY_PROBE_ENVELOPE_BYTES} bytes`,
          state: "probe-failed",
          version: 1,
        };
      }
      chunks.push(result.value);
    }
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      state: "probe-failed",
      version: 1,
    };
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as ProbePayload;
  } catch {
    return { reason: "probe returned invalid JSON", state: "probe-failed", version: 1 };
  }
}

async function probeTarget(options: {
  expectedBuildId?: string;
  fetchImpl: typeof fetch;
  headers?: HeadersInit;
  retries: number;
  retryDelayMs: number;
  deadlineAt: number;
  phaseTimeoutMs: number;
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
  const phaseTimeoutPayload = (): ProbePayload => ({
    phaseTimedOut: true,
    reason: `cacheability probing exceeded its ${options.phaseTimeoutMs}ms phase deadline`,
    state: "probe-failed",
    version: 1,
  });
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    const remainingMs = options.deadlineAt - Date.now();
    if (remainingMs <= 0) return phaseTimeoutPayload();

    const controller = new AbortController();
    const attemptTimeoutMs = Math.min(options.timeoutMs, remainingMs);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let retryable = true;
    try {
      const url = new URL(options.target.pathname, options.targetUrl);
      url.searchParams.set(VINEXT_CACHEABILITY_PROBE_QUERY_PARAM, `${probeId}-${attempt}`);
      const request = (async () => {
        const response = await options.fetchImpl(url, {
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
        if (
          options.expectedBuildId !== undefined &&
          response.headers.get(VINEXT_CDN_BUILD_ID_HEADER) !== options.expectedBuildId
        ) {
          void response.body?.cancel().catch(() => {});
          return {
            kind: "retry" as const,
            reason: "probe reached an unexpected Worker build",
            retryable: true,
          };
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          return {
            kind: "retry" as const,
            reason: `probe returned HTTP ${response.status}`,
            retryable: response.status === 404 || response.status === 503,
          };
        }
        return { kind: "complete" as const, payload: await readProbeEnvelope(response) };
      })();
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new DOMException(`Timed out after ${attemptTimeoutMs}ms`, "AbortError"));
        }, attemptTimeoutMs);
      });
      const result = await Promise.race([request, timedOut]);
      if (Date.now() >= options.deadlineAt) return phaseTimeoutPayload();
      if (result.kind === "complete") return result.payload;
      reason = result.reason;
      retryable = result.retryable;
    } catch (error) {
      if (Date.now() >= options.deadlineAt) return phaseTimeoutPayload();
      reason =
        error instanceof Error && error.name === "AbortError"
          ? `probe timed out after ${attemptTimeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (!retryable || attempt === options.retries) break;
    if (options.retryDelayMs > 0) {
      const delayMs = Math.min(options.retryDelayMs, Math.max(0, options.deadlineAt - Date.now()));
      if (delayMs <= 0) return phaseTimeoutPayload();
      await delay(delayMs);
    }
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
  phaseTimeoutMs?: number;
  /** @internal Apply stricter artifact bounds for focused coordinator tests. */
  manifestLimits?: { maxBytes?: number; maxRoutes?: number };
}): Promise<CacheabilityProbeResult> {
  const secret = readPrerenderSecret(options.root);
  const concurrency = Math.max(1, options.concurrency ?? 25);
  const retries = Math.max(0, options.retries ?? DEFAULT_CACHEABILITY_PROBE_RETRIES);
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? DEFAULT_CACHEABILITY_PROBE_RETRY_DELAY_MS,
  );
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CACHEABILITY_PROBE_REQUEST_TIMEOUT_MS);
  const phaseTimeoutMs = Math.max(
    1,
    options.phaseTimeoutMs ?? DEFAULT_CACHEABILITY_PROBE_PHASE_TIMEOUT_MS,
  );
  const deadlineAt = Date.now() + phaseTimeoutMs;
  const routes: Record<string, CacheabilityManifestRoute> = {};
  const cacheableTargets: CdnWarmTarget[] = [];
  const failures: string[] = [];
  const maxManifestBytes = Math.min(
    options.manifestLimits?.maxBytes ?? MAX_CACHEABILITY_MANIFEST_BYTES,
    MAX_CACHEABILITY_MANIFEST_BYTES,
  );
  const maxManifestRoutes = Math.min(
    options.manifestLimits?.maxRoutes ?? MAX_CACHEABILITY_MANIFEST_ROUTES,
    MAX_CACHEABILITY_MANIFEST_ROUTES,
  );
  const emptyManifest: CacheabilityManifest = {
    buildId: options.buildId,
    routes: {},
    version: 1,
  };
  let manifestBytes = Buffer.byteLength(JSON.stringify(emptyManifest));
  const routeEntryBytes = new Map<string, number>();
  let limitFailure: Error | null = null;
  let phaseTimedOut = false;
  let nextIndex = 0;

  const addRouteWithinManifestLimits = (key: string, route: CacheabilityManifestRoute): boolean => {
    const previousBytes = routeEntryBytes.get(key);
    const nextRouteCount =
      previousBytes === undefined ? routeEntryBytes.size + 1 : routeEntryBytes.size;
    if (nextRouteCount > maxManifestRoutes) {
      limitFailure = cacheabilityManifestRouteLimitError(nextRouteCount, maxManifestRoutes);
      return false;
    }

    // This is the exact UTF-8 contribution of the entry to JSON.stringify's
    // routes object. Counting entries incrementally avoids repeatedly
    // serializing an ever-growing manifest while preserving the artifact's
    // byte boundary exactly (including escaped keys and multibyte paths).
    const nextEntryBytes = Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(route)}`);
    const nextManifestBytes =
      previousBytes === undefined
        ? manifestBytes + nextEntryBytes + (routeEntryBytes.size > 0 ? 1 : 0)
        : manifestBytes - previousBytes + nextEntryBytes;
    if (nextManifestBytes > maxManifestBytes) {
      limitFailure = cacheabilityManifestByteLimitError(nextManifestBytes, maxManifestBytes);
      return false;
    }

    routes[key] = route;
    routeEntryBytes.set(key, nextEntryBytes);
    manifestBytes = nextManifestBytes;
    return true;
  };

  const worker = async (): Promise<void> => {
    while (!limitFailure && !phaseTimedOut && nextIndex < options.targets.length) {
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
        deadlineAt,
        fetchImpl: options.fetchImpl ?? fetch,
        headers: options.headers,
        retries,
        retryDelayMs,
        phaseTimeoutMs,
        secret,
        target,
        targetUrl: options.targetUrl,
        timeoutMs,
      });
      if (limitFailure) return;
      if (result.phaseTimedOut) {
        phaseTimedOut = true;
        return;
      }
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
      const key = cacheabilityManifestRouteKey(
        route.kind,
        route.pattern,
        route.representation,
        route.requestKey,
      );
      if (!addRouteWithinManifestLimits(key, route)) return;
      cacheableTargets.push(target);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, options.targets.length) }, () => worker()),
  );
  if (limitFailure) throw limitFailure;
  if (phaseTimedOut || Date.now() >= deadlineAt) {
    throw new Error(`cacheability probing exceeded its ${phaseTimeoutMs}ms phase deadline`);
  }
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
