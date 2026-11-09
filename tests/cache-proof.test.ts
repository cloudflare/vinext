import { describe, expect, it } from "vite-plus/test";
import {
  buildRenderObservation,
  classifyRenderObservationDowngrade,
  createCacheEntryReuseProof,
  hasCompleteNegativeRequestApiProof,
  type RenderObservation,
} from "../packages/vinext/src/server/cache-proof.js";

describe("cache proof model", () => {
  it("requires complete negative request-api observations before absence is proof", () => {
    const complete = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: ["posts", "posts"],
      completeness: "complete",
      dynamicFetches: ["https://api.example.test/posts?token=secret"],
      output: {
        kind: "layout",
        layoutId: "layout:/blog",
        rootBoundaryId: "layout:/",
        routeId: "route:/blog",
      },
      pathTags: ["/blog"],
      requestApis: [
        { kind: "headers", status: "notObserved" },
        { kind: "cookies", status: "notObserved" },
      ],
    });
    const partial = buildRenderObservation({
      ...complete,
      completeness: "partial",
    });
    const observed = buildRenderObservation({
      ...complete,
      requestApis: [
        { kind: "headers", status: "observed" },
        { kind: "cookies", status: "notObserved" },
      ],
    });
    const missingApiKind = buildRenderObservation({
      ...complete,
      requestApis: [{ kind: "cookies", status: "notObserved" }],
    });
    const duplicateApiKind = {
      ...complete,
      requestApis: [
        { kind: "headers", status: "observed" },
        { kind: "headers", status: "notObserved" },
        { kind: "cookies", status: "notObserved" },
      ],
    } satisfies RenderObservation;

    expect(hasCompleteNegativeRequestApiProof(complete, ["headers", "cookies"])).toBe(true);
    expect(hasCompleteNegativeRequestApiProof(partial, ["headers", "cookies"])).toBe(false);
    expect(hasCompleteNegativeRequestApiProof(observed, ["headers", "cookies"])).toBe(false);
    expect(hasCompleteNegativeRequestApiProof(missingApiKind, ["headers", "cookies"])).toBe(false);
    expect(hasCompleteNegativeRequestApiProof(duplicateApiKind, ["headers", "cookies"])).toBe(
      false,
    );
    expect(complete.cacheTags).toEqual(["posts"]);
    expect(JSON.stringify(complete.dynamicFetches)).not.toContain("secret");
  });

  it("classifies public request observations as public variant dimensions", () => {
    const observation = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: [],
      completeness: "complete",
      dynamicFetches: [],
      output: {
        kind: "app-html",
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/products/:id",
      },
      pathTags: ["/products/1"],
      requestApis: [
        { kind: "params", status: "observed" },
        { kind: "searchParams", status: "observed" },
      ],
    });

    expect(observation.downgrade).toEqual(classifyRenderObservationDowngrade(observation));
    expect(observation.downgrade).toMatchObject({
      isPublicCacheCandidate: true,
      target: "publicVariant",
      fallback: null,
    });
    expect(observation.downgrade.reasons.map((reason) => reason.code)).toEqual([
      "CP_DOWNGRADE_PUBLIC_REQUEST_API",
      "CP_DOWNGRADE_PUBLIC_REQUEST_API",
    ]);
  });

  it("classifies private request API observations away from public cache", () => {
    const observation = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: [],
      completeness: "complete",
      dynamicFetches: [],
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: null,
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/account",
      },
      pathTags: ["/account"],
      requestApis: [
        { kind: "cookies", status: "observed" },
        { kind: "draftMode", status: "observed" },
        { kind: "headers", status: "observed" },
      ],
    });

    expect(observation.downgrade).toMatchObject({
      isPublicCacheCandidate: false,
      target: "privateUncacheable",
      fallback: {
        code: "CP_PRIVATE_DYNAMIC_DOWNGRADE",
        mode: "privateUncacheable",
        scope: "affectedOutput",
      },
    });
    expect(observation.downgrade.reasons).toEqual([
      {
        code: "CP_DOWNGRADE_PRIVATE_REQUEST_API",
        requestApi: "cookies",
        target: "private",
      },
      {
        code: "CP_DOWNGRADE_DRAFT_MODE",
        requestApi: "draftMode",
        target: "privateUncacheable",
      },
      {
        code: "CP_DOWNGRADE_PRIVATE_REQUEST_API",
        requestApi: "headers",
        target: "private",
      },
    ]);
  });

  it("classifies dynamic and incomplete observations as fresh-render downgrades", () => {
    const observation = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "unknown",
      cacheTags: [],
      completeness: "partial",
      dynamicFetches: ["https://api.example.test/live?token=secret"],
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: null,
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/live",
      },
      pathTags: ["/live"],
      requestApis: [{ kind: "connection", status: "observed" }],
    });

    expect(observation.downgrade).toMatchObject({
      isPublicCacheCandidate: false,
      target: "freshRender",
      fallback: {
        code: "CP_PRIVATE_DYNAMIC_DOWNGRADE",
        mode: "renderFresh",
        scope: "affectedOutput",
      },
    });
    expect(observation.downgrade.reasons.map((reason) => reason.code)).toEqual([
      "CP_DOWNGRADE_CACHEABILITY_UNKNOWN",
      "CP_DOWNGRADE_INCOMPLETE_OBSERVATION",
      "CP_DOWNGRADE_DYNAMIC_FETCH",
      "CP_DOWNGRADE_DYNAMIC_REQUEST_API",
    ]);
    expect(JSON.stringify(observation.downgrade)).not.toContain("secret");
  });

  it("projects a missing static layout artifact decision into planner-visible cache entry proof", () => {
    expect(createCacheEntryReuseProof(null)).toEqual({
      kind: "runtime-cache-entry",
      decision: null,
    });
  });
});
