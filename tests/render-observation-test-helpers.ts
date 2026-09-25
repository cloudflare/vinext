import {
  buildRenderObservation,
  buildRenderRequestApiObservations,
  type CacheProofOutputScope,
  type RenderObservation,
  type RenderRequestApiKind,
} from "../packages/vinext/src/server/cache-proof.js";

const HTML_OUTPUT_SCOPE: CacheProofOutputScope = {
  kind: "app-html",
  renderEpoch: null,
  rootBoundaryId: null,
  routeId: "route:/cached",
};

/** A complete render observation that read no request API, including searchParams. */
export function buildQueryInvariantRenderObservation(): RenderObservation {
  return buildTestRenderObservation([]);
}

/** A complete render observation that read searchParams. */
export function buildSearchParamsReadRenderObservation(): RenderObservation {
  return buildTestRenderObservation(["searchParams"]);
}

function buildTestRenderObservation(
  observed: readonly RenderRequestApiKind[],
  output: CacheProofOutputScope = HTML_OUTPUT_SCOPE,
): RenderObservation {
  return buildRenderObservation({
    boundaryOutcome: { kind: "success" },
    cacheability: "public",
    cacheTags: [],
    completeness: "complete",
    dynamicFetches: [],
    output,
    pathTags: [],
    requestApis: buildRenderRequestApiObservations({
      completeness: "complete",
      observed,
    }),
  });
}

/** Finalizer observation builders for a render that left the query unread. */
export const queryInvariantObservationBuilders = {
  createHtmlRenderObservation: buildQueryInvariantRenderObservation,
  createRscRenderObservation: buildQueryInvariantRenderObservation,
};

/** Observations for a regeneration render that left the query unread. */
export function queryInvariantRegenObservations(): {
  htmlRenderObservation: RenderObservation;
  rscRenderObservation: RenderObservation;
} {
  return {
    htmlRenderObservation: buildQueryInvariantRenderObservation(),
    rscRenderObservation: buildQueryInvariantRenderObservation(),
  };
}

/** Prerender manifest observations for a render that left the query unread. */
export function queryInvariantPrerenderObservations(): {
  html: RenderObservation;
  rsc: RenderObservation;
} {
  return {
    html: buildQueryInvariantRenderObservation(),
    rsc: buildTestRenderObservation([], {
      kind: "app-rsc",
      mountedSlotsFingerprint: null,
      renderEpoch: null,
      rootBoundaryId: null,
      routeId: "route:/cached",
    }),
  };
}
