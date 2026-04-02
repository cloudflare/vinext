import React from "react";
import { describe, expect, it } from "vite-plus/test";
import { UNMATCHED_SLOT } from "../packages/vinext/src/shims/slot.js";
import {
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
  APP_UNMATCHED_SLOT_WIRE_VALUE,
  createAppPayloadCacheKey,
  createAppPayloadRouteId,
  normalizeAppElements,
  readAppElementsMetadata,
  resolveVisitedResponseInterceptionContext,
} from "../packages/vinext/src/server/app-elements.js";

describe("app elements payload helpers", () => {
  it("normalizes the unmatched-slot wire marker to UNMATCHED_SLOT for slot entries", () => {
    const normalized = normalizeAppElements({
      [APP_ROOT_LAYOUT_KEY]: "/",
      [APP_ROUTE_KEY]: "route:/dashboard",
      "page:/dashboard": React.createElement("main", null, "dashboard"),
      "slot:modal:/": APP_UNMATCHED_SLOT_WIRE_VALUE,
    });

    expect(normalized["slot:modal:/"]).toBe(UNMATCHED_SLOT);
    expect(normalized["page:/dashboard"]).not.toBe(UNMATCHED_SLOT);
  });

  it("does not rewrite the unmatched-slot wire marker for non-slot entries", () => {
    const normalized = normalizeAppElements({
      [APP_ROOT_LAYOUT_KEY]: "/",
      [APP_ROUTE_KEY]: "route:/dashboard",
      "page:/dashboard": APP_UNMATCHED_SLOT_WIRE_VALUE,
    });

    expect(normalized["page:/dashboard"]).toBe(APP_UNMATCHED_SLOT_WIRE_VALUE);
  });

  it("reads route metadata from the normalized payload", () => {
    const metadata = readAppElementsMetadata(
      normalizeAppElements({
        [APP_INTERCEPTION_CONTEXT_KEY]: "/feed",
        [APP_ROOT_LAYOUT_KEY]: "/(dashboard)",
        [APP_ROUTE_KEY]: "route:/dashboard",
        "route:/dashboard": React.createElement("div", null, "route"),
      }),
    );

    expect(metadata.routeId).toBe("route:/dashboard");
    expect(metadata.interceptionContext).toBe("/feed");
    expect(metadata.rootLayoutTreePath).toBe("/(dashboard)");
  });

  it("defaults missing interception context metadata to null", () => {
    const metadata = readAppElementsMetadata(
      normalizeAppElements({
        [APP_ROOT_LAYOUT_KEY]: "/",
        [APP_ROUTE_KEY]: "route:/dashboard",
        "route:/dashboard": React.createElement("div", null, "route"),
      }),
    );

    expect(metadata.interceptionContext).toBeNull();
  });

  it("encodes intercepted route ids and cache keys with a NUL separator", () => {
    expect(createAppPayloadRouteId("/photos/42", null)).toBe("route:/photos/42");
    expect(createAppPayloadRouteId("/photos/42", "/feed")).toBe("route:/photos/42\0/feed");
    expect(createAppPayloadCacheKey("/photos/42.rsc", null)).toBe("/photos/42.rsc");
    expect(createAppPayloadCacheKey("/photos/42.rsc", "/feed")).toBe("/photos/42.rsc\0/feed");
  });

  it("preserves the request cache context when a direct-route payload omits it", () => {
    expect(resolveVisitedResponseInterceptionContext("/feed", null)).toBe("/feed");
    expect(resolveVisitedResponseInterceptionContext("/feed", "/feed")).toBe("/feed");
    expect(resolveVisitedResponseInterceptionContext("/feed", "/gallery")).toBe("/gallery");
    expect(resolveVisitedResponseInterceptionContext(null, null)).toBeNull();
  });

  it("rejects payloads with a missing __route key", () => {
    expect(() =>
      readAppElementsMetadata(
        normalizeAppElements({
          [APP_ROOT_LAYOUT_KEY]: "/",
        }),
      ),
    ).toThrow("[vinext] Missing __route string in App Router payload");
  });

  it("rejects payloads with an invalid __rootLayout value", () => {
    expect(() =>
      readAppElementsMetadata(
        normalizeAppElements({
          [APP_ROOT_LAYOUT_KEY]: 123,
          [APP_ROUTE_KEY]: "route:/dashboard",
        }),
      ),
    ).toThrow("[vinext] Invalid __rootLayout in App Router payload: expected string or null");
  });

  it("rejects payloads with a missing __rootLayout key", () => {
    expect(() =>
      readAppElementsMetadata(
        normalizeAppElements({
          [APP_ROUTE_KEY]: "route:/dashboard",
        }),
      ),
    ).toThrow("[vinext] Missing __rootLayout key in App Router payload");
  });

  it("rejects payloads with an invalid __interceptionContext value", () => {
    expect(() =>
      readAppElementsMetadata(
        normalizeAppElements({
          [APP_INTERCEPTION_CONTEXT_KEY]: 123,
          [APP_ROOT_LAYOUT_KEY]: "/",
          [APP_ROUTE_KEY]: "route:/dashboard",
        }),
      ),
    ).toThrow("[vinext] Invalid __interceptionContext in App Router payload");
  });
});
