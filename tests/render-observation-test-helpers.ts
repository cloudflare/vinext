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
 * reads, a request API registry without exactly one entry per kind, a missing
 * field, an incomplete downgrade or one the observation doesn't classify to,
 * another schema version, or another artifact's output. Each must give no seed, without throwing.
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
  // Replace one kind's entry in the complete request API registry.
  const replacingRequestApi = (kind: RenderRequestApiKind, entry: unknown) =>
    corrupt((observation) => {
      observation.requestApis = (observation.requestApis as { kind: string }[]).map((requestApi) =>
        requestApi.kind === kind ? entry : requestApi,
      );
    });
  return [
    {
      label: "bogus request API kind",
      observations: replacingRequestApi("headers", { kind: "bogus", status: "notObserved" }),
    },
    {
      label: "bogus request API status",
      observations: replacingRequestApi("headers", { kind: "headers", status: "bogus" }),
    },
    {
      label: "a request API registry missing kinds",
      observations: corrupt((observation) => {
        observation.requestApis = [{ kind: "searchParams", status: "notObserved" }];
      }),
    },
    {
      label: "a request API registry with a duplicate kind",
      observations: corrupt((observation) => {
        observation.requestApis = [
          ...(observation.requestApis as unknown[]),
          { kind: "searchParams", status: "notObserved" },
        ];
      }),
    },
    {
      label: "a request API registry repeating one kind in place of another",
      observations: replacingRequestApi("headers", {
        kind: "searchParams",
        status: "notObserved",
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
    ...[
      { label: "an incomplete downgrade fallback", fallback: { kind: "breakerFallback" } },
      {
        label: "a downgrade fallback with an unknown code",
        fallback: {
          code: "bogus",
          fields: {},
          kind: "breakerFallback",
          mode: "renderFresh",
          scope: "route",
        },
      },
      {
        label: "a downgrade fallback with a bogus trace field",
        fallback: {
          code: "CP_PRIVATE_DYNAMIC_DOWNGRADE",
          fields: { reasonCodes: [1] },
          kind: "breakerFallback",
          mode: "renderFresh",
          scope: "route",
        },
      },
    ].map(({ label, fallback }) => ({
      label,
      observations: corrupt((observation) => {
        observation.downgrade = { ...(observation.downgrade as object), fallback };
      }),
    })),
    ...[
      {
        label: "a downgrade reason with an unknown code",
        reason: { code: "bogus", target: "freshRender" },
      },
      {
        label: "a downgrade reason missing its own fields",
        reason: { code: "CP_DOWNGRADE_DYNAMIC_FETCH", target: "freshRender" },
      },
      {
        label: "a downgrade reason with another reason's target",
        reason: { code: "CP_DOWNGRADE_CACHEABILITY_PRIVATE", target: "public" },
      },
    ].map(({ label, reason }) => ({
      label,
      observations: corrupt((observation) => {
        observation.downgrade = { ...(observation.downgrade as object), reasons: [reason] };
      }),
    })),
    // Valid downgrades, but not the one the observation classifies to.
    {
      label: "a public downgrade on an observation with a dynamic fetch",
      observations: corrupt((observation) => {
        observation.dynamicFetches = ["https://example.test/data"];
      }),
    },
    {
      label: "a public downgrade on an uncacheable observation",
      observations: corrupt((observation) => {
        observation.cacheability = "uncacheable";
      }),
    },
    {
      label: "a public downgrade on an observation that read draftMode",
      observations: replacingRequestApi("draftMode", { kind: "draftMode", status: "observed" }),
    },
    {
      label: "a downgrade with another target",
      observations: corrupt((observation) => {
        observation.downgrade = {
          ...(observation.downgrade as object),
          isPublicCacheCandidate: true,
          target: "publicVariant",
        };
      }),
    },
    {
      label: "a downgrade with a reason the observation doesn't carry",
      observations: corrupt((observation) => {
        observation.downgrade = {
          ...(observation.downgrade as object),
          reasons: [
            {
              code: "CP_DOWNGRADE_PUBLIC_REQUEST_API",
              requestApi: "params",
              target: "publicVariant",
            },
          ],
        };
      }),
    },
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

/**
 * Valid, query-invariant prerender observations of renders core's
 * request-time writer would never store: a failed render, a render that isn't
 * public, or a mounted-slot RSC variant. Each must give no seed.
 */
export function unstorablePrerenderObservations(): { label: string; observations: unknown }[] {
  const { html, rsc } = queryInvariantPrerenderObservations();
  const rebuild = (
    change: Partial<Parameters<typeof buildRenderObservation>[0]>,
    rscOutput: CacheProofOutputScope = rsc.output,
  ) => {
    const observe = (observation: RenderObservation, output: CacheProofOutputScope) =>
      buildRenderObservation({ ...observation, ...change, output });
    return { html: observe(html, html.output), rsc: observe(rsc, rscOutput) };
  };
  return [
    ...(["private", "uncacheable", "unknown"] as const).map((cacheability) => ({
      label: `a ${cacheability} render`,
      observations: rebuild({ cacheability }),
    })),
    ...(
      [
        { kind: "notFound" },
        { kind: "error" },
        { kind: "redirect", location: "/", status: 307 },
      ] as const
    ).map((boundaryOutcome) => ({
      label: `a ${boundaryOutcome.kind} render`,
      observations: rebuild({ boundaryOutcome }),
    })),
    {
      label: "a mounted-slot RSC variant",
      observations: rebuild(
        {},
        {
          ...(rsc.output as Extract<CacheProofOutputScope, { kind: "app-rsc" }>),
          mountedSlotsFingerprint: "slots:0",
        },
      ),
    },
  ];
}
