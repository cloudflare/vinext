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

/**
 * Prerender observations that aren't complete observations of this proof
 * model: a field value the searchParams proof doesn't accept, one per field it
 * reads, a missing field, another schema version, or another artifact's
 * output. Each must give no seed, without throwing.
 */
export function malformedPrerenderObservations(): { label: string; observations: unknown }[] {
  const corrupt = (change: (observation: Record<string, unknown>) => void): unknown => {
    const observations = queryInvariantPrerenderObservations();
    const html: Record<string, unknown> = { ...observations.html };
    const rsc: Record<string, unknown> = { ...observations.rsc };
    change(html);
    change(rsc);
    return { html, rsc };
  };
  return [
    {
      label: "bogus request API kind",
      observations: corrupt((observation) => {
        observation.requestApis = [{ kind: "bogus", status: "notObserved" }];
      }),
    },
    {
      label: "bogus request API status",
      observations: corrupt((observation) => {
        // Two entries for one kind make the proof rank the statuses.
        observation.requestApis = [
          { kind: "searchParams", status: "notObserved" },
          { kind: "searchParams", status: "bogus" },
        ];
      }),
    },
    {
      label: "bogus completeness",
      observations: corrupt((observation) => {
        observation.completeness = "bogus";
      }),
    },
    {
      label: "only the fields the searchParams proof reads",
      observations: corrupt((observation) => {
        for (const key of Object.keys(observation)) {
          if (key !== "completeness" && key !== "requestApis") delete observation[key];
        }
      }),
    },
    ...["schemaVersion", "output", "cacheTags", "downgrade"].map((field) => ({
      label: `missing ${field}`,
      observations: corrupt((observation) => {
        delete observation[field];
      }),
    })),
    {
      label: "another proof model schema version",
      observations: corrupt((observation) => {
        observation.schemaVersion = 2;
      }),
    },
    {
      label: "another artifact's output",
      observations: (() => {
        const { html, rsc } = queryInvariantPrerenderObservations();
        return { html: rsc, rsc: html };
      })(),
    },
  ];
}
