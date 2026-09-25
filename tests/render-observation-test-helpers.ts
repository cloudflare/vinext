import {
  buildRenderObservation,
  buildRenderRequestApiObservations,
  type RenderObservation,
  type RenderRequestApiKind,
} from "../packages/vinext/src/server/cache-proof.js";

/** A complete render observation that read no request API, including searchParams. */
export function buildQueryInvariantRenderObservation(): RenderObservation {
  return buildTestRenderObservation([]);
}

/** A complete render observation that read searchParams. */
export function buildSearchParamsReadRenderObservation(): RenderObservation {
  return buildTestRenderObservation(["searchParams"]);
}

function buildTestRenderObservation(observed: readonly RenderRequestApiKind[]): RenderObservation {
  return buildRenderObservation({
    boundaryOutcome: { kind: "success" },
    cacheability: "public",
    cacheTags: [],
    completeness: "complete",
    dynamicFetches: [],
    output: {
      kind: "app-html",
      renderEpoch: null,
      rootBoundaryId: null,
      routeId: "route:/cached",
    },
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
