import type { ArtifactCompatibilityEnvelope } from "./artifact-compatibility.js";
import {
  buildCacheVariantWithRouteBudget,
  DEFAULT_CACHE_VARIANT_BUDGET,
  type StaticLayoutCacheProofOutputScope,
} from "./cache-proof.js";
import {
  CLIENT_REUSE_MANIFEST_SKIP_VERIFICATION_ENTRY_BUDGET,
  countUtf8Bytes,
  DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS,
  serializeClientReuseManifest,
} from "./client-reuse-manifest.js";
import { AppElementsWire, type AppElements } from "./app-elements.js";
import {
  createStaticLayoutClientReuseArtifactCompatibility,
  createStaticLayoutClientReusePayloadHash,
  createStaticLayoutClientReuseRouteId,
} from "./static-layout-client-reuse-proof.js";
import {
  createSameRouteLayoutClientReusePayloadHash,
  createSameRouteLayoutClientReuseVariantCacheKey,
} from "./same-route-layout-client-reuse-proof.js";
import type { AppRouterState } from "./app-browser-state.js";

type ClientReuseManifestLimits = typeof DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS;

type VisibleAppState = Pick<AppRouterState, "elements" | "visibleCommitVersion">;

type BrowserClientReuseManifestEntry = Readonly<{
  artifactCompatibility: ArtifactCompatibilityEnvelope;
  id: string;
  payloadHash: string;
  privacy: "public";
  variantCacheKey: string;
}>;

type CreateClientReuseManifestHeaderOptions = Readonly<{
  limits?: ClientReuseManifestLimits;
  retainedElements?: readonly AppElements[];
  sameRoutePathname?: string;
}>;

function capClientReuseManifestProducerLimits(
  limits: ClientReuseManifestLimits,
): ClientReuseManifestLimits {
  return {
    ...limits,
    maxEntryCount: Math.min(
      limits.maxEntryCount,
      CLIENT_REUSE_MANIFEST_SKIP_VERIFICATION_ENTRY_BUDGET,
    ),
  };
}

function serializeBoundedClientReuseManifest(input: {
  entries: readonly BrowserClientReuseManifestEntry[];
  limits: ClientReuseManifestLimits;
  visibleCommitVersion: number;
}): string | null {
  const entries = input.entries.slice(0, input.limits.maxEntryCount);
  // Binary search for the largest prefix that fits. JSON array serialization
  // is monotonic here: adding an entry cannot reduce the byte count.
  let low = 1;
  let high = entries.length;
  let best: string | null = null;

  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const serialized = serializeClientReuseManifest({
      entries: entries.slice(0, size),
      replayWindow: {
        validFromVisibleCommitVersion: input.visibleCommitVersion,
        validUntilVisibleCommitVersion: input.visibleCommitVersion,
      },
      visibleCommitVersion: input.visibleCommitVersion,
    });
    if (countUtf8Bytes(serialized) <= input.limits.maxManifestBytes) {
      best = serialized;
      low = size + 1;
    } else {
      high = size - 1;
    }
  }

  return best;
}

function hasRetainedElement(elements: AppElements, elementId: string): boolean {
  return Object.hasOwn(elements, elementId);
}

function createStaticLayoutEntry(input: {
  artifactCompatibility: ArtifactCompatibilityEnvelope;
  layoutId: string;
}): BrowserClientReuseManifestEntry | null {
  const routeId = createStaticLayoutClientReuseRouteId(input.layoutId);
  const output: StaticLayoutCacheProofOutputScope = {
    kind: "layout",
    layoutId: input.layoutId,
    rootBoundaryId: input.artifactCompatibility.rootBoundaryId,
    routeId,
  };
  const candidateVariant = buildCacheVariantWithRouteBudget({
    budget: DEFAULT_CACHE_VARIANT_BUDGET,
    dimensions: [],
    output,
    routeBudget: {
      routeId: output.routeId,
      variantCacheKeys: [],
    },
  });
  if (candidateVariant.kind !== "variant") {
    return null;
  }

  const artifactCompatibility = createStaticLayoutClientReuseArtifactCompatibility({
    artifactCompatibility: input.artifactCompatibility,
    layoutId: input.layoutId,
    rootBoundaryId: output.rootBoundaryId,
    routeId: output.routeId,
    variantCacheKey: candidateVariant.variant.cacheKey,
  });

  return {
    artifactCompatibility,
    id: input.layoutId,
    payloadHash: createStaticLayoutClientReusePayloadHash({
      artifactCompatibility,
      layoutId: input.layoutId,
      rootBoundaryId: output.rootBoundaryId,
      routeId: output.routeId,
      variantCacheKey: candidateVariant.variant.cacheKey,
    }),
    privacy: "public",
    variantCacheKey: candidateVariant.variant.cacheKey,
  };
}

function createSameRouteLayoutEntry(input: {
  artifactCompatibility: ArtifactCompatibilityEnvelope;
  layoutId: string;
  pathname: string;
  routeId: string;
}): BrowserClientReuseManifestEntry {
  const variantCacheKey = createSameRouteLayoutClientReuseVariantCacheKey(input);
  return {
    artifactCompatibility: input.artifactCompatibility,
    id: input.layoutId,
    payloadHash: createSameRouteLayoutClientReusePayloadHash(input),
    privacy: "public",
    variantCacheKey,
  };
}

export function createClientReuseManifestHeaderFromVisibleAppState(
  state: VisibleAppState,
  options: CreateClientReuseManifestHeaderOptions = {},
): string | null {
  const limits = capClientReuseManifestProducerLimits(
    options.limits ?? DEFAULT_CLIENT_REUSE_MANIFEST_LIMITS,
  );
  const entries: BrowserClientReuseManifestEntry[] = [];
  const retainedLayoutIds = new Set<string>();

  // The visible tree is the primary owner. An optimistic loading shell may
  // additionally own target-route layouts that were prefetched but were not
  // present at navigation start; those layouts are equally retained while the
  // authoritative page response streams in.
  for (const elements of [state.elements, ...(options.retainedElements ?? [])]) {
    const metadata = AppElementsWire.readMetadata(elements);
    for (const layoutId of metadata.layoutIds) {
      if (entries.length >= limits.maxEntryCount) break;
      if (retainedLayoutIds.has(layoutId)) continue;
      if (layoutId.length > limits.maxEntryIdLength) continue;
      if (metadata.layoutFlags[layoutId] !== "s") continue;
      if (!hasRetainedElement(elements, layoutId)) continue;

      const parsedKey = AppElementsWire.parseElementKey(layoutId);
      if (parsedKey?.kind !== "layout") continue;

      const entry = createStaticLayoutEntry({
        artifactCompatibility: metadata.artifactCompatibility,
        layoutId,
      });
      if (entry) {
        entries.push(entry);
        retainedLayoutIds.add(layoutId);
      }
    }
    if (entries.length >= limits.maxEntryCount) break;
  }

  if (options.sameRoutePathname !== undefined && entries.length < limits.maxEntryCount) {
    const metadata = AppElementsWire.readMetadata(state.elements);
    for (const layoutId of metadata.layoutIds) {
      if (entries.length >= limits.maxEntryCount) break;
      if (retainedLayoutIds.has(layoutId)) continue;
      if (layoutId.length > limits.maxEntryIdLength) continue;
      if (metadata.layoutFlags[layoutId] !== "d") continue;
      if (!hasRetainedElement(state.elements, layoutId)) continue;
      if (AppElementsWire.parseElementKey(layoutId)?.kind !== "layout") continue;

      entries.push(
        createSameRouteLayoutEntry({
          artifactCompatibility: metadata.artifactCompatibility,
          layoutId,
          pathname: options.sameRoutePathname,
          routeId: metadata.routeId,
        }),
      );
      retainedLayoutIds.add(layoutId);
    }
  }

  if (entries.length === 0) {
    return null;
  }

  return serializeBoundedClientReuseManifest({
    entries,
    limits,
    visibleCommitVersion: state.visibleCommitVersion,
  });
}
