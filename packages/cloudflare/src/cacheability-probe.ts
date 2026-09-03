import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  cacheabilityManifestRouteKey,
  cacheabilityRequestIdentity,
  cacheabilityRoutePathname,
  normalizeCacheabilityRoutePathname,
  type CacheabilityManifest,
  type CacheabilityManifestRoute,
} from "vinext/internal/server/cacheability-manifest";
import type { PrerenderRoutePattern } from "vinext/internal/build/prerender-paths";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_CACHEABILITY_PROBE_QUERY_PARAM,
  VINEXT_CACHEABILITY_PROBE_ROUTE_HEADER,
  VINEXT_PRERENDER_SECRET_HEADER,
} from "vinext/internal/server/headers";
import { VINEXT_CDN_BUILD_ID_HEADER } from "./cache/cdn-build-id.js";
import type { CdnWarmTarget } from "./cdn-warm.js";
import {
  cacheabilityManifestByteLimitError,
  MAX_CACHEABILITY_MANIFEST_BYTES,
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
  rendererStatic?: boolean;
  routePathname?: string;
  state?: string;
  status?: number;
  version?: number;
  phaseTimedOut?: boolean;
  scope?: "identity" | "pattern";
  terminal?: true;
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
  /** Paired representations admitted only if their own final warm render remains cacheable. */
  speculativeTargets: CdnWarmTarget[];
};

type ProbeRouteState = "static-candidate" | "dynamic" | "probe-failed";

function sharedPathPrefix(pathnames: readonly string[]): string | null {
  if (pathnames.length === 0) return null;
  let prefix = pathnames[0];
  for (const pathname of pathnames.slice(1)) {
    const limit = Math.min(prefix.length, pathname.length);
    let length = 0;
    while (length < limit && prefix.charCodeAt(length) === pathname.charCodeAt(length)) length++;
    prefix = prefix.slice(0, length);
  }

  while (
    prefix.length > 1 &&
    pathnames.some(
      (pathname) =>
        pathname !== prefix &&
        (prefix.endsWith("/") ? !pathname.startsWith(prefix) : !pathname.startsWith(`${prefix}/`)),
    )
  ) {
    const slash = prefix.lastIndexOf("/");
    prefix = slash <= 0 ? "/" : prefix.slice(0, slash + 1);
  }
  return prefix || null;
}

/** Remove a shared pathname prefix only when it makes the serialized route smaller. */
function compactManifestRoutePaths(route: CacheabilityManifestRoute): CacheabilityManifestRoute {
  const pathnames = [
    ...(route.runtimePaths ?? []),
    ...Object.values(route.staticPaths ?? {}).flatMap((paths) => paths ?? []),
  ];
  const pathPrefix = sharedPathPrefix(pathnames);
  if (!pathPrefix) return route;

  const compacted: CacheabilityManifestRoute = {
    ...route,
    pathPrefix,
    ...(route.runtimePaths
      ? { runtimePaths: route.runtimePaths.map((pathname) => pathname.slice(pathPrefix.length)) }
      : {}),
    ...(route.staticPaths
      ? {
          staticPaths: Object.fromEntries(
            Object.entries(route.staticPaths).map(([representation, paths]) => [
              representation,
              paths!.map((pathname) => pathname.slice(pathPrefix.length)),
            ]),
          ),
        }
      : {}),
  };
  return Buffer.byteLength(JSON.stringify(compacted)) < Buffer.byteLength(JSON.stringify(route))
    ? compacted
    : route;
}

function isProbeRouteState(value: unknown): value is ProbeRouteState {
  return value === "static-candidate" || value === "dynamic" || value === "probe-failed";
}

export function readPrerenderSecret(root: string): string {
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
  headers.set(VINEXT_CACHEABILITY_PROBE_HEADER, "1");
  if (options.target.route) {
    headers.set(
      VINEXT_CACHEABILITY_PROBE_ROUTE_HEADER,
      encodeURIComponent(JSON.stringify([options.target.route.kind, options.target.route.pattern])),
    );
  }
  headers.set(VINEXT_PRERENDER_SECRET_HEADER, options.secret);

  let reason = "probe failed";
  const probeId = randomUUID();
  const phaseTimeoutPayload = (): ProbePayload => ({
    phaseTimedOut: true,
    reason: `cacheability probing made no progress for ${options.phaseTimeoutMs}ms`,
    state: "probe-failed",
    version: 1,
  });
  let ordinaryFailures = 0;
  for (let attempt = 0; ; attempt++) {
    if (options.getDeadlineAt() - Date.now() <= 0) return phaseTimeoutPayload();

    const controller = new AbortController();
    const requestDeadlineAt = Date.now() + options.timeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOutBy: "phase" | "request" | null = null;
    let retryable = true;
    let retryUntilDeadline = false;
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
            retryUntilDeadline: true,
          };
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          return {
            kind: "retry" as const,
            reason: `probe returned HTTP ${response.status}`,
            retryable: response.status === 404 || response.status === 503,
            retryUntilDeadline: false,
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
      retryUntilDeadline = result.retryUntilDeadline;
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
    // Version overrides can become available at different times for different
    // cache keys. Readiness on the reserved endpoint therefore cannot prove a
    // concrete route has reached the staged build. Keep retrying only this
    // routing mismatch until the no-progress deadline; application/transport
    // failures retain the caller's bounded retry policy.
    if (!retryable) break;
    if (!retryUntilDeadline && ++ordinaryFailures > options.retries) break;
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
  fallbackRoutePatterns?: readonly PrerenderRoutePattern[];
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
  manifestLimits?: { maxBytes?: number };
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
  const speculativeTargets: CdnWarmTarget[] = [];
  const failures: string[] = [];
  const maxManifestBytes = Math.min(
    options.manifestLimits?.maxBytes ?? MAX_CACHEABILITY_MANIFEST_BYTES,
    MAX_CACHEABILITY_MANIFEST_BYTES,
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
  let probed = 0;
  let completedPathCount = 0;
  let skippedPathCount = 0;
  let staticPathCount = 0;
  let dynamicPathCount = 0;

  type ConcretePathResult = {
    rendererStatic: boolean;
    representation: CdnWarmTarget["kind"];
    state: Exclude<ProbeRouteState, "probe-failed">;
    terminal: boolean;
  };
  type PatternClassification = {
    canPrune: boolean;
    groups: ConcretePathGroup[];
    key: string;
    resultKeys: Set<string>;
    pruned: boolean;
    results: Map<string, ConcretePathResult>;
    route: NonNullable<CdnWarmTarget["route"]>;
    requestStageMayTerminate: boolean;
  };
  type ConcretePathGroup = {
    deferred: boolean;
    pattern: PatternClassification;
    primary: CdnWarmTarget;
    result?: ConcretePathResult;
    resultKey: string;
    routePathname: string;
    targets: CdnWarmTarget[];
  };
  const targetPreference = (target: CdnWarmTarget): number => {
    if (target.route?.kind === "app-route") return target.kind === "app-route" ? 0 : 1;
    return target.kind === "html" ? 0 : target.kind === "rsc-full" ? 1 : 2;
  };
  const patterns = new Map<string, PatternClassification>();
  const routableTargets: CdnWarmTarget[] = [];
  let missingRouteMetadata = 0;
  for (const target of options.targets) {
    if (!target.route) {
      missingRouteMetadata++;
      continue;
    }
    const key = cacheabilityManifestRouteKey(target.route.kind, target.route.pattern);
    const pattern = patterns.get(key) ?? {
      canPrune: true,
      groups: [],
      key,
      resultKeys: new Set<string>(),
      pruned: false,
      results: new Map(),
      route: target.route,
      requestStageMayTerminate: false,
    };
    pattern.requestStageMayTerminate ||=
      target.route.cacheabilityProbe?.requestStageMayTerminate === true;
    pattern.canPrune &&=
      target.route.cacheabilityProbe?.canPrunePattern === true &&
      target.route.cacheabilityProbe.routeMayResolve !== true &&
      target.route.cacheabilityProbe.requestStageMayTerminate !== true;
    patterns.set(key, pattern);
    routableTargets.push(target);
  }
  if (missingRouteMetadata > 0) {
    failures.push(
      `${missingRouteMetadata} warm target${missingRouteMetadata === 1 ? " is" : "s are"} missing route-pattern metadata`,
    );
  }
  const targetGroups = new Map<
    string,
    {
      pattern: PatternClassification;
      resultKey: string;
      routePathname: string;
      targets: CdnWarmTarget[];
    }
  >();
  for (const target of routableTargets) {
    const route = target.route!;
    const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
    const pattern = patterns.get(key)!;
    const routePathname =
      route.cacheabilityProbe?.concretePathname ??
      cacheabilityRoutePathname(target.pathname, target.kind);
    const resultKey = routePathname;
    pattern.resultKeys.add(resultKey);
    const concreteKey = `${key}\0${resultKey}`;
    const group = targetGroups.get(concreteKey) ?? {
      pattern,
      resultKey,
      routePathname,
      targets: [],
    };
    group.targets.push(target);
    targetGroups.set(concreteKey, group);
  }
  const groups: ConcretePathGroup[] = Array.from(targetGroups.values(), (targetGroup) => {
    targetGroup.targets.sort((first, second) => {
      const preference = targetPreference(first) - targetPreference(second);
      return preference || first.sourcePathname.localeCompare(second.sourcePathname);
    });
    const group = { ...targetGroup, deferred: false, primary: targetGroup.targets[0] };
    targetGroup.pattern.groups.push(group);
    return group;
  });

  const reportProgress = (): void => {
    options.onProgress?.({
      completed: completedPathCount + (missingRouteMetadata > 0 ? 1 : 0),
      dynamic: dynamicPathCount,
      failed: failures.length,
      probed,
      skipped: skippedPathCount,
      static: staticPathCount,
      total: groups.length + (missingRouteMetadata > 0 ? 1 : 0),
    });
  };

  const addRouteWithinManifestLimits = (key: string, route: CacheabilityManifestRoute): boolean => {
    const previousBytes = routeEntryBytes.get(key);
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

  const moveGroupToResolvedRoute = (
    group: ConcretePathGroup,
    route: Pick<PrerenderRoutePattern, "kind" | "pattern">,
  ): PatternClassification => {
    const previousPattern = group.pattern;
    const key = cacheabilityManifestRouteKey(route.kind, route.pattern);
    let pattern = patterns.get(key);
    if (!pattern) {
      pattern = {
        canPrune: false,
        groups: [],
        key,
        resultKeys: new Set<string>(),
        pruned: false,
        results: new Map(),
        route,
        requestStageMayTerminate: previousPattern.requestStageMayTerminate,
      };
      patterns.set(key, pattern);
    }
    pattern.canPrune = false;
    pattern.requestStageMayTerminate ||= previousPattern.requestStageMayTerminate;
    // A direct destination probe may have provisionally pruned this pattern
    // before the routed source completed. Its retained concrete observation is
    // authoritative once another public path joins the resolved route.
    pattern.pruned = false;
    if (pattern === previousPattern) return pattern;

    const previousGroupIndex = previousPattern.groups.indexOf(group);
    if (previousGroupIndex !== -1) previousPattern.groups.splice(previousGroupIndex, 1);
    if (!previousPattern.groups.some((candidate) => candidate.resultKey === group.resultKey)) {
      previousPattern.resultKeys.delete(group.resultKey);
    }
    pattern.groups.push(group);
    pattern.resultKeys.add(group.resultKey);
    group.pattern = pattern;
    return pattern;
  };

  const updateGroupRoutePathname = (group: ConcretePathGroup, routePathname: string): void => {
    const normalized = normalizeCacheabilityRoutePathname(routePathname);
    if (normalized === group.routePathname) return;
    const pattern = group.pattern;
    const previousResultKey = group.resultKey;
    group.routePathname = normalized;
    group.resultKey = normalized;
    if (!pattern.groups.some((candidate) => candidate.resultKey === previousResultKey)) {
      pattern.resultKeys.delete(previousResultKey);
    }
    pattern.resultKeys.add(group.resultKey);
  };

  const deferPairedRepresentationsAtOriginalRoute = (group: ConcretePathGroup): void => {
    const pairedTargets = group.targets.filter((target) => target !== group.primary);
    if (pairedTargets.length === 0) return;
    group.targets = [group.primary];
    for (const target of pairedTargets) {
      const routePathname =
        target.route?.cacheabilityProbe?.concretePathname ??
        cacheabilityRoutePathname(target.pathname, target.kind);
      const deferredGroup: ConcretePathGroup = {
        deferred: true,
        pattern: group.pattern,
        primary: target,
        resultKey: routePathname,
        routePathname,
        targets: [target],
      };
      group.pattern.groups.push(deferredGroup);
      group.pattern.resultKeys.add(routePathname);
    }
  };

  const classifyConcretePath = async (group: ConcretePathGroup): Promise<void> => {
    if (group.pattern.pruned) {
      skippedPathCount += 1;
      completedPathCount += 1;
      reportProgress();
      return;
    }
    const target = group.primary;
    const request = new Request(new URL(target.pathname, options.targetUrl), {
      headers: target.headers,
    });
    const identity = cacheabilityRequestIdentity(request);
    if (!identity || identity.representation !== target.kind) {
      failures.push(`${target.label}: warm request does not have a cacheable request identity`);
      completedPathCount += 1;
      reportProgress();
      return;
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
    if (limitFailure) return;
    if (result.phaseTimedOut) {
      phaseTimedOut = true;
      return;
    }
    if (
      result.version !== 1 ||
      (result.kind !== "app-page" && result.kind !== "app-route" && result.kind !== "pages-page") ||
      typeof result.pattern !== "string" ||
      !result.pattern.startsWith("/") ||
      !isProbeRouteState(result.state) ||
      (result.scope !== undefined && result.scope !== "identity" && result.scope !== "pattern") ||
      (result.scope === "pattern" && result.state !== "dynamic") ||
      (result.routePathname !== undefined &&
        (typeof result.routePathname !== "string" ||
          !result.routePathname.startsWith("/") ||
          result.routePathname.includes("?") ||
          result.routePathname.includes("#"))) ||
      (result.terminal !== undefined && result.terminal !== true) ||
      (result.terminal === true &&
        (result.state !== "dynamic" ||
          result.scope !== "identity" ||
          !group.pattern.requestStageMayTerminate)) ||
      (result.rendererStatic !== undefined && typeof result.rendererStatic !== "boolean") ||
      !Number.isInteger(result.status) ||
      result.status! < 100 ||
      result.status! > 599
    ) {
      failures.push(`${target.label}: ${result.reason ?? "probe returned an invalid envelope"}`);
      completedPathCount += 1;
      reportProgress();
      return;
    }
    if (result.state === "probe-failed") {
      failures.push(`${target.label}: ${result.reason ?? "probe failed"}`);
      completedPathCount += 1;
      reportProgress();
      return;
    }
    if (!target.route) {
      failures.push(`${target.label}: probe resolved without route metadata`);
      completedPathCount += 1;
      reportProgress();
      return;
    }
    const resolvedRouteChanged =
      result.kind !== target.route.kind || result.pattern !== target.route.pattern;
    const resolvedPathnameChanged =
      result.routePathname !== undefined &&
      normalizeCacheabilityRoutePathname(result.routePathname) !== group.routePathname;
    if (resolvedRouteChanged) {
      if (target.route.cacheabilityProbe?.routeMayResolve !== true) {
        failures.push(
          `${target.label}: probe resolved to unexpected route ${result.pattern ?? ""}`,
        );
        completedPathCount += 1;
        reportProgress();
        return;
      }
      if (result.routePathname === undefined) {
        failures.push(`${target.label}: probe resolved without a concrete route pathname`);
        completedPathCount += 1;
        reportProgress();
        return;
      }
    }
    if (
      target.route.cacheabilityProbe?.routeMayResolve === true &&
      (resolvedRouteChanged || resolvedPathnameChanged)
    ) {
      // The representative request proves only its own routed destination.
      // Keep alternate representations attached to the original route so
      // their final completed renders can still pass manifest admission.
      deferPairedRepresentationsAtOriginalRoute(group);
    }
    if (resolvedRouteChanged) {
      moveGroupToResolvedRoute(group, { kind: result.kind, pattern: result.pattern });
    }
    if (result.routePathname !== undefined) {
      updateGroupRoutePathname(group, result.routePathname);
    }

    const classification: ConcretePathResult = {
      rendererStatic: result.rendererStatic === true,
      representation: target.kind,
      state: result.state,
      terminal: result.terminal === true,
    };
    group.result = classification;
    const previousClassification = group.pattern.results.get(group.resultKey);
    if (
      !previousClassification ||
      (previousClassification.state === "static-candidate" && classification.state === "dynamic") ||
      (previousClassification.state === classification.state &&
        previousClassification.rendererStatic &&
        !classification.rendererStatic)
    ) {
      group.pattern.results.set(group.resultKey, classification);
    }
    const patternIsDefinitelyDynamic =
      result.state === "dynamic" && result.scope === "pattern" && group.pattern.canPrune;
    if (patternIsDefinitelyDynamic) {
      group.pattern.pruned = true;
      dynamicPathCount += 1;
      completedPathCount += 1;
      reportProgress();
      return;
    }
    if (result.state === "static-candidate") {
      staticPathCount += 1;
    } else {
      dynamicPathCount += 1;
    }
    completedPathCount += 1;
    reportProgress();
  };

  reportProgress();
  let activeProbes = 0;
  const slotWaiters: Array<() => void> = [];
  const acquireProbeSlot = async (): Promise<void> => {
    if (activeProbes < concurrency) {
      activeProbes++;
      return;
    }
    await new Promise<void>((resolve) => slotWaiters.push(resolve));
  };
  const releaseProbeSlot = (): void => {
    const next = slotWaiters.shift();
    if (next) next();
    else activeProbes--;
  };
  let pendingRouteMovers = groups.filter(
    (group) => group.primary.route?.cacheabilityProbe?.routeMayResolve === true,
  ).length;
  let settleRouteMovers: (() => void) | undefined;
  const routeMoversSettled =
    pendingRouteMovers === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          settleRouteMovers = resolve;
        });
  const runGroup = async (group: ConcretePathGroup): Promise<void> => {
    const mayResolveRoute = group.primary.route?.cacheabilityProbe?.routeMayResolve === true;
    while (true) {
      if (!mayResolveRoute && group.pattern.pruned && pendingRouteMovers > 0) {
        await routeMoversSettled;
      }
      await acquireProbeSlot();
      if (!mayResolveRoute && group.pattern.pruned && pendingRouteMovers > 0) {
        releaseProbeSlot();
        continue;
      }
      break;
    }
    try {
      if (!limitFailure && !phaseTimedOut) await classifyConcretePath(group);
    } finally {
      releaseProbeSlot();
      if (mayResolveRoute && --pendingRouteMovers === 0) settleRouteMovers?.();
    }
  };
  const initialPatternGroups = Array.from(patterns.values(), (pattern) => [...pattern.groups]);
  await Promise.all(
    initialPatternGroups.map(async ([representative, ...siblings]) => {
      await runGroup(representative);
      await Promise.all(siblings.map(runGroup));
    }),
  );
  if (limitFailure) throw limitFailure;
  if (phaseTimedOut || Date.now() >= getDeadlineAt()) {
    throw new Error(`cacheability probing made no progress for ${phaseTimeoutMs}ms`);
  }
  let classified = 0;
  let dynamic = 0;
  let skipped = 0;
  const fallbackRoutes = new Map<string, PrerenderRoutePattern>();
  for (const fallbackRoute of options.fallbackRoutePatterns ?? []) {
    const key = cacheabilityManifestRouteKey(fallbackRoute.kind, fallbackRoute.pattern);
    fallbackRoutes.set(key, fallbackRoute);
  }
  for (const [key, fallbackRoute] of fallbackRoutes) {
    // A pattern with concrete targets is classified below. Its fallback fact
    // is merged into that one route record so exact runtime results still win
    // without counting or serializing the pattern twice.
    if (patterns.has(key)) continue;
    if (
      !addRouteWithinManifestLimits(key, {
        kind: fallbackRoute.kind,
        pattern: fallbackRoute.pattern,
        state: "static-candidate",
      })
    ) {
      break;
    }
    classified += 1;
  }
  if (limitFailure) throw limitFailure;
  // Next.js classifies every generateStaticParams result independently. Store
  // each observed concrete path exactly once, then compact the shared route
  // prefix. Paired HTML/RSC or HTML/data representations reuse the path's
  // membership but must pass their own completed-render admission check.
  for (const pattern of patterns.values()) {
    if (pattern.pruned) {
      classified += 1;
      dynamic += 1;
      skipped += 1;
      const loadingShellTargets = pattern.groups.flatMap((group) =>
        group.targets.filter((target) => target.kind === "rsc-loading-shell"),
      );
      if (loadingShellTargets.length > 0) {
        cacheableTargets.push(...loadingShellTargets);
        speculativeTargets.push(...loadingShellTargets);
        const route: CacheabilityManifestRoute = {
          kind: pattern.route.kind,
          pattern: pattern.route.pattern,
          runtimeRepresentation: "rsc-loading-shell",
          state: "runtime-check",
        };
        if (!addRouteWithinManifestLimits(pattern.key, route)) break;
      }
      continue;
    }
    if (pattern.results.size === 0 && !pattern.groups.some((group) => group.deferred)) continue;
    classified += 1;
    if (Array.from(pattern.results.values()).some((result) => result.state === "dynamic")) {
      dynamic += 1;
    }

    const rendererStaticTargets = new Map<string, CdnWarmTarget>();
    const runtimePathSet = new Set<string>();
    for (const group of pattern.groups) {
      if (group.deferred) {
        runtimePathSet.add(group.routePathname);
        cacheableTargets.push(...group.targets);
        speculativeTargets.push(...group.targets);
        continue;
      }
      const result = group.result;
      if (result?.state === "static-candidate") {
        if (result.rendererStatic) {
          const previous = rendererStaticTargets.get(group.routePathname);
          if (!previous || targetPreference(group.primary) < targetPreference(previous)) {
            rendererStaticTargets.set(group.routePathname, group.primary);
          }
        } else {
          runtimePathSet.add(group.routePathname);
        }
        cacheableTargets.push(...group.targets);
        speculativeTargets.push(...group.targets.filter((target) => target !== group.primary));
        continue;
      }

      const pairedTargets = group.targets.filter((target) => target !== group.primary);
      if (result?.terminal !== true || pairedTargets.length > 0) {
        runtimePathSet.add(group.routePathname);
      }
      // A representation-specific response policy can make an RSC/data
      // sibling reusable even when the representative HTML render is private.
      // The final completed render decides admission without another probe.
      if (!pattern.pruned) {
        cacheableTargets.push(...pairedTargets);
        speculativeTargets.push(...pairedTargets);
      }
    }
    const staticPaths: CacheabilityManifestRoute["staticPaths"] = {};
    for (const [routePathname, staticTarget] of rendererStaticTargets) {
      // Conflicting observations for one resolved route identity must retain
      // runtime admission rather than certifying the static observation.
      if (runtimePathSet.has(routePathname)) continue;
      const paths = staticPaths[staticTarget.kind] ?? [];
      paths.push(routePathname);
      staticPaths[staticTarget.kind] = paths;
    }
    for (const paths of Object.values(staticPaths)) paths?.sort();
    const allObservedPathsStatic =
      pattern.results.size === pattern.resultKeys.size &&
      Array.from(pattern.results.values()).every((result) => result.state === "static-candidate");
    const allObservedPathsStaticallyGenerated =
      allObservedPathsStatic &&
      Array.from(pattern.results.values()).every((result) => result.rendererStatic);
    const hasStaticFallback = fallbackRoutes.has(pattern.key);
    const soleGroup = pattern.groups.length === 1 ? pattern.groups[0] : null;
    const literalPatternNamesSolePath =
      soleGroup !== null &&
      !/(^|\/):/.test(pattern.route.pattern) &&
      normalizeCacheabilityRoutePathname(pattern.route.pattern) === soleGroup.routePathname;
    let route: CacheabilityManifestRoute;
    if (literalPatternNamesSolePath) {
      const result = pattern.results.get(soleGroup.resultKey);
      route =
        result?.state === "static-candidate"
          ? pattern.route.kind === "app-route"
            ? {
                kind: pattern.route.kind,
                pattern: pattern.route.pattern,
                state: "static-candidate",
              }
            : result.rendererStatic
              ? {
                  kind: pattern.route.kind,
                  pattern: pattern.route.pattern,
                  state: "runtime-check",
                  staticRepresentation: result.representation,
                }
              : {
                  kind: pattern.route.kind,
                  pattern: pattern.route.pattern,
                  state: "runtime-check",
                }
          : {
              kind: pattern.route.kind,
              pattern: pattern.route.pattern,
              state: "runtime-check",
            };
    } else {
      route = compactManifestRoutePaths({
        kind: pattern.route.kind,
        pattern: pattern.route.pattern,
        state: "runtime-check",
        ...(hasStaticFallback || allObservedPathsStaticallyGenerated
          ? { allowUnknown: true, unknownState: "static-candidate" as const }
          : {}),
        ...(runtimePathSet.size > 0 ? { runtimePaths: Array.from(runtimePathSet).sort() } : {}),
        ...(Object.keys(staticPaths).length > 0 ? { staticPaths } : {}),
      });
    }
    if (!addRouteWithinManifestLimits(pattern.key, route)) break;
  }
  if (limitFailure) throw limitFailure;
  const sortedRoutes = Object.fromEntries(
    Object.entries(routes).sort(([first], [second]) => first.localeCompare(second)),
  );
  cacheableTargets.sort((first, second) =>
    `${first.kind}\0${first.sourcePathname}`.localeCompare(
      `${second.kind}\0${second.sourcePathname}`,
    ),
  );
  speculativeTargets.sort((first, second) =>
    `${first.kind}\0${first.sourcePathname}`.localeCompare(
      `${second.kind}\0${second.sourcePathname}`,
    ),
  );
  return {
    cacheableTargets,
    classified,
    dynamic,
    failures,
    manifest: { buildId: options.buildId, routes: sortedRoutes, version: 1 },
    probed,
    skipped,
    speculativeTargets,
  };
}
