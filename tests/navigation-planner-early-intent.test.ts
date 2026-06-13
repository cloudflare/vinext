import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TRACE_SCHEMA_VERSION,
  NavigationTraceReasonCodes,
} from "../packages/vinext/src/server/navigation-trace.js";
import {
  navigationPlanner,
  type EarlyNavigationIntentDecisionV0,
  type EarlyNavigationIntentFactsV0,
} from "../packages/vinext/src/server/navigation-planner.js";

function createFacts(
  overrides: Partial<EarlyNavigationIntentFactsV0> = {},
): EarlyNavigationIntentFactsV0 {
  return {
    basePath: "",
    currentHref: "https://example.com/docs?q=1",
    mode: "push",
    scroll: true,
    targetHref: "https://example.com/docs?q=1#section",
    ...overrides,
  };
}

function classify(
  overrides: Partial<EarlyNavigationIntentFactsV0> = {},
): EarlyNavigationIntentDecisionV0 {
  return navigationPlanner.classifyEarlyNavigationIntent(createFacts(overrides));
}

function expectSingleTraceEntry(
  decision: EarlyNavigationIntentDecisionV0,
  code: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  expect(decision.trace).toEqual({
    schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
    entries: [{ code, fields }],
  });
}

describe("navigationPlanner early navigation intent classification", () => {
  it("classifies a same-page hash change as a same-document scroll", () => {
    const decision = classify({
      currentHref: "https://example.com/docs?q=1",
      targetHref: "https://example.com/docs?q=1#section",
    });

    expect(decision).toEqual({
      kind: "sameDocumentScroll",
      hash: "#section",
      mode: "push",
      scroll: true,
      trace: decision.trace,
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.sameDocumentScroll, {
      targetHref: "https://example.com/docs?q=1#section",
    });
  });

  it("preserves replace mode and scroll intent on a same-document scroll", () => {
    const decision = classify({
      mode: "replace",
      scroll: false,
      currentHref: "https://example.com/docs",
      targetHref: "https://example.com/docs#footer",
    });

    expect(decision).toMatchObject({
      kind: "sameDocumentScroll",
      hash: "#footer",
      mode: "replace",
      scroll: false,
    });
  });

  it("resolves a relative hash target against the current href", () => {
    const decision = classify({
      currentHref: "https://example.com/docs?q=1",
      targetHref: "#section",
    });

    expect(decision).toMatchObject({ kind: "sameDocumentScroll", hash: "#section" });
  });

  it("classifies a same-path search change as a cache-bypassing flight navigation", () => {
    const decision = classify({
      currentHref: "https://example.com/docs?q=1",
      targetHref: "https://example.com/docs?q=2",
    });

    expect(decision).toEqual({
      kind: "flightNavigation",
      bypassNavigationCache: true,
      trace: decision.trace,
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.samePageSearch, {
      targetHref: "https://example.com/docs?q=2",
    });
  });

  it("treats a search change as a flight navigation even when the target adds a hash", () => {
    const decision = classify({
      currentHref: "https://example.com/docs?q=1",
      targetHref: "https://example.com/docs?q=2#section",
    });

    expect(decision).toMatchObject({ kind: "flightNavigation", bypassNavigationCache: true });
  });

  it("classifies a cross-path navigation as a non-bypassing flight navigation", () => {
    const decision = classify({
      currentHref: "https://example.com/docs",
      targetHref: "https://example.com/blog",
    });

    expect(decision).toEqual({
      kind: "flightNavigation",
      bypassNavigationCache: false,
      trace: decision.trace,
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.crossDocumentFlight, {
      targetHref: "https://example.com/blog",
    });
  });

  it("treats search params that differ only by encoding as the same page", () => {
    // "+" and "%20" both decode to a space, so this is not a search change and
    // must not bypass the navigation cache. Guards the choice of comparing
    // serialised params over raw search strings.
    const decision = classify({
      currentHref: "https://example.com/docs?a=+",
      targetHref: "https://example.com/docs?a=%20",
    });

    expect(decision).toMatchObject({ kind: "flightNavigation", bypassNavigationCache: false });
  });

  it("does not treat an identical URL as a same-document scroll", () => {
    const decision = classify({
      currentHref: "https://example.com/docs?q=1",
      targetHref: "https://example.com/docs?q=1",
    });

    expect(decision).toMatchObject({ kind: "flightNavigation", bypassNavigationCache: false });
  });

  it("treats hash removal as a flight navigation, not a same-document scroll", () => {
    const decision = classify({
      currentHref: "https://example.com/docs#section",
      targetHref: "https://example.com/docs",
    });

    expect(decision).toMatchObject({ kind: "flightNavigation", bypassNavigationCache: false });
  });

  it("does not treat a cross-origin same-path hash target as a same-document scroll", () => {
    const decision = classify({
      currentHref: "https://a.example/docs?q=1",
      targetHref: "https://b.example/docs?q=1#section",
    });

    expect(decision).toMatchObject({ kind: "flightNavigation", bypassNavigationCache: false });
  });

  it("does not treat a cross-origin same-path search target as same-page search", () => {
    const decision = classify({
      currentHref: "https://a.example/docs?q=1",
      targetHref: "https://b.example/docs?q=2",
    });

    expect(decision).toMatchObject({ kind: "flightNavigation", bypassNavigationCache: false });
  });

  it("strips the base path before comparing pathnames for a hash change", () => {
    const decision = classify({
      basePath: "/app",
      currentHref: "https://example.com/app/docs",
      targetHref: "https://example.com/app/docs#section",
    });

    expect(decision).toMatchObject({ kind: "sameDocumentScroll", hash: "#section" });
  });

  it("falls back to a non-bypassing flight navigation when an href cannot be parsed", () => {
    const decision = classify({
      currentHref: "not a url",
      targetHref: "also not a url",
    });

    expect(decision).toMatchObject({ kind: "flightNavigation", bypassNavigationCache: false });
  });
});
