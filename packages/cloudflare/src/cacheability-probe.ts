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
  scope?: "identity" | "pattern";
};

export type CacheabilityProbeProgress = {
  completed: number;
  dynamic: number;
  failed: number;
  probed: number;
  skipped: number;
  static: number;
  total: number;
};

export type CacheabilityProbeResult = {
  cacheableTargets: CdnWarmTarget[];
  classified: number;
  dynamic: number;
  failures: string[];
  manifest: CacheabilityManifest;
  probed: number;
  skipped: number;
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
  getDeadlineAt: () => number;
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
    reason: `cacheability probing made no progress for ${options.phaseTimeoutMs}ms`,
    state: "probe-failed",
    version: 1,
  });
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (options.getDeadlineAt() - Date.now() <= 0) return phaseTimeoutPayload();

    const controller = new AbortController();
    const requestDeadlineAt = Date.now() + options.timeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOutBy: "phase" | "request" | null = null;
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
        const checkDeadline = (): void => {
          const phaseDeadlineAt = options.getDeadlineAt();
          const deadlineAt = Math.min(requestDeadlineAt, phaseDeadlineAt);
          const remainingMs = deadlineAt - Date.now();
          if (remainingMs > 0) {
            timeout = setTimeout(checkDeadline, remainingMs);
            return;
          }
          // Another concurrent request can extend the no-progress deadline
          // after this attempt starts. Re-read it whenever the timer fires;
          // only the per-request deadline itself remains fixed.
          timedOutBy = requestDeadlineAt <= phaseDeadlineAt ? "request" : "phase";
          controller.abort();
          reject(new DOMException("Probe deadline exceeded", "AbortError"));
        };
        checkDeadline();
      });
      const result = await Promise.race([request, timedOut]);
      if (Date.now() >= options.getDeadlineAt()) return phaseTimeoutPayload();
      if (result.kind === "complete") return result.payload;
      reason = result.reason;
      retryable = result.retryable;
    } catch (error) {
      if (timedOutBy === "phase" || Date.now() >= options.getDeadlineAt()) {
        return phaseTimeoutPayload();
      }
      reason =
        error instanceof Error && error.name === "AbortError"
          ? `probe timed out after ${options.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (!retryable || attempt === options.retries) break;
    if (options.retryDelayMs > 0) {
      const delayMs = Math.min(
        options.retryDelayMs,
        Math.max(0, options.getDeadlineAt() - Date.now()),
      );
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
  onProgress?: (progress: CacheabilityProbeProgress) => void;
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
  let lastProgressAt = Date.now();
  const getDeadlineAt = () => lastProgressAt + phaseTimeoutMs;
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
  let probed = 0;
  let skipped = 0;
  let staticCount = 0;
  let dynamicCount = 0;
  const patternDynamic = new Set<string>();
  const rscBySourcePath = new Map(
    options.targets
      .filter(
        (target) =>
          target.kind === "rsc-full" &&
          target.route?.cacheabilityProbe?.canReuseHtmlForRsc === true,
      )
      .map((target) => [target.sourcePathname, target] as const),
  );
  const htmlSources = new Set(
    options.targets
      .filter(
        (target) =>
          target.kind === "html" && target.route?.cacheabilityProbe?.canReuseHtmlForRsc === true,
      )
      .map((target) => target.sourcePathname),
  );
  const targets = options.targets.filter(
    (target) => target.kind !== "rsc-full" || !htmlSources.has(target.sourcePathname),
  );

  const routeKey = (target: CdnWarmTarget): string | null =>
    target.route ? `${target.route.kind}\0${target.route.pattern}` : null;

  const reportProgress = (): void => {
    options.onProgress?.({
      completed: staticCount + dynamicCount + failures.length + skipped,
      dynamic: dynamicCount,
      failed: failures.length,
      probed,
      skipped,
      static: staticCount,
      total: options.targets.length,
    });
  };

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

  const classifyTarget = async (target: CdnWarmTarget): Promise<ProbePayload | null> => {
    const knownPattern = routeKey(target);
    if (knownPattern && patternDynamic.has(knownPattern)) {
      skipped += 1;
      reportProgress();
      return null;
    }

    const request = new Request(new URL(target.pathname, options.targetUrl), {
      headers: target.headers,
    });
    const identity = cacheabilityRequestIdentity(request);
    if (!identity || identity.representation !== target.kind) {
      failures.push(`${target.label}: warm request does not have a cacheable request identity`);
      reportProgress();
      return null;
    }

    const result = await probeTarget({
      expectedBuildId: options.expectedResponseBuildId,
      fetchImpl: options.fetchImpl ?? fetch,
      getDeadlineAt,
      headers: options.headers,
      retries,
      retryDelayMs,
      phaseTimeoutMs,
      secret,
      target,
      targetUrl: options.targetUrl,
      timeoutMs,
    });
    probed += 1;
    lastProgressAt = Date.now();
    if (limitFailure) return null;
    if (result.phaseTimedOut) {
      phaseTimedOut = true;
      return null;
    }
    if (
      result.version !== 1 ||
      (result.kind !== "app-page" && result.kind !== "app-route" && result.kind !== "pages-page") ||
      typeof result.pattern !== "string" ||
      !result.pattern.startsWith("/") ||
      !isProbeRouteState(result.state) ||
      (result.scope !== undefined && result.scope !== "identity" && result.scope !== "pattern") ||
      (result.scope === "pattern" && result.state !== "dynamic") ||
      !Number.isInteger(result.status) ||
      result.status! < 100 ||
      result.status! > 599
    ) {
      failures.push(`${target.label}: ${result.reason ?? "probe returned an invalid envelope"}`);
      reportProgress();
      return null;
    }
    if (result.state === "probe-failed") {
      failures.push(`${target.label}: ${result.reason ?? "probe failed"}`);
      reportProgress();
      return null;
    }

    if (result.state !== "static-candidate") {
      dynamicCount += 1;
      if (
        result.scope === "pattern" &&
        target.route?.cacheabilityProbe?.canPrunePattern === true &&
        knownPattern === `${result.kind}\0${result.pattern}`
      ) {
        patternDynamic.add(`${result.kind}\0${result.pattern}`);
      }
      reportProgress();
      return result;
    }

    const route: CacheabilityManifestRoute = {
      kind: result.kind,
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
    if (!addRouteWithinManifestLimits(key, route)) return null;
    cacheableTargets.push(target);
    staticCount += 1;
    reportProgress();
    return result;
  };

  const worker = async (): Promise<void> => {
    while (!limitFailure && !phaseTimedOut && nextIndex < targets.length) {
      const target = targets[nextIndex++];
      const pairedRsc = target.kind === "html" ? rscBySourcePath.get(target.sourcePathname) : null;
      const knownPattern = routeKey(target);
      if (knownPattern && patternDynamic.has(knownPattern)) {
        skipped += pairedRsc ? 2 : 1;
        reportProgress();
        continue;
      }
      const result = await classifyTarget(target);
      if (!result || limitFailure || phaseTimedOut) continue;

      if (!pairedRsc) continue;
      // An HTML App Page render produces the RSC payload consumed by SSR, so a
      // completed successful HTML render is a strict superset of the work done
      // by the paired full-RSC request. Keep both exact CDN identities in the
      // manifest, while avoiding a second user-code render. Runtime admission
      // still rechecks the exact RSC identity, status, completed body, dynamic
      // observations, and final response vetoes; a representation-specific
      // dynamic observation therefore fails closed as static-to-dynamic.
      // Terminal HTML and RSC requests can intentionally use different HTTP
      // statuses, so classify those representations independently.
      if (
        result.state === "static-candidate" &&
        result.kind === "app-page" &&
        result.status! >= 200 &&
        result.status! < 300 &&
        pairedRsc.route?.kind === "app-page" &&
        pairedRsc.route.pattern === result.pattern
      ) {
        const pairedRequest = new Request(new URL(pairedRsc.pathname, options.targetUrl), {
          headers: pairedRsc.headers,
        });
        const pairedIdentity = cacheabilityRequestIdentity(pairedRequest);
        if (!pairedIdentity || pairedIdentity.representation !== "rsc-full") {
          failures.push(
            `${pairedRsc.label}: warm request does not have a cacheable request identity`,
          );
          reportProgress();
          continue;
        }
        const pairedRoute: CacheabilityManifestRoute = {
          kind: "app-page",
          pattern: result.pattern!,
          representation: pairedIdentity.representation,
          requestKey: pairedIdentity.requestKey,
          state: "static-candidate",
          status: result.status!,
        };
        const pairedKey = cacheabilityManifestRouteKey(
          pairedRoute.kind,
          pairedRoute.pattern,
          pairedRoute.representation,
          pairedRoute.requestKey,
        );
        if (!addRouteWithinManifestLimits(pairedKey, pairedRoute)) continue;
        cacheableTargets.push(pairedRsc);
        staticCount += 1;
        reportProgress();
        continue;
      }
      if (result.state === "static-candidate") {
        await classifyTarget(pairedRsc);
        continue;
      }
      const resultPatternKey = `${result.kind}\0${result.pattern}`;
      if (
        result.state === "dynamic" &&
        (result.scope !== "pattern" ||
          target.route?.cacheabilityProbe?.canPrunePattern !== true ||
          routeKey(target) !== resultPatternKey)
      ) {
        await classifyTarget(pairedRsc);
      } else if (result.state === "dynamic") {
        skipped += 1;
        reportProgress();
      }
    }
  };

  reportProgress();
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  if (limitFailure) throw limitFailure;
  if (phaseTimedOut || Date.now() >= getDeadlineAt()) {
    throw new Error(`cacheability probing made no progress for ${phaseTimeoutMs}ms`);
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
    classified: staticCount + dynamicCount,
    dynamic: dynamicCount,
    failures,
    manifest: { buildId: options.buildId, routes: sortedRoutes, version: 1 },
    probed,
    skipped,
  };
}
