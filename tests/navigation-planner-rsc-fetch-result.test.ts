import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TRACE_SCHEMA_VERSION,
  NavigationTraceReasonCodes,
} from "../packages/vinext/src/server/navigation-trace.js";
import {
  navigationPlanner,
  type RscFetchResultDecision,
  type RscFetchResultFacts,
} from "../packages/vinext/src/server/navigation-planner.js";

function createFacts(overrides: Partial<RscFetchResultFacts> = {}): RscFetchResultFacts {
  return {
    clientCompatibilityId: "client-build",
    compatibilityIdHeader: "client-build",
    currentHref: "/current",
    effectiveHistoryUpdateMode: "replace",
    hasBody: true,
    isRscContentType: true,
    origin: "https://example.com",
    redirectDepth: 0,
    requestPreviousNextUrl: null,
    responseOk: true,
    responseUrl: "https://example.com/current.rsc?_rsc=abc",
    source: "live",
    streamedRedirectTarget: null,
    ...overrides,
  };
}

function classify(overrides: Partial<RscFetchResultFacts> = {}): RscFetchResultDecision {
  return navigationPlanner.classifyRscFetchResult(createFacts(overrides));
}

function expectSingleTraceEntry(
  decision: RscFetchResultDecision,
  code: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  expect(decision.trace).toEqual({
    schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
    entries: [
      {
        code,
        fields,
      },
    ],
  });
}

describe("navigationPlanner RSC fetch-result classification", () => {
  it("hard-navigates non-ok RSC responses as invalid payloads", () => {
    const decision = classify({
      responseOk: false,
      responseUrl: "https://example.com/error.rsc?_rsc=abc",
    });

    expect(decision).toMatchObject({
      discardBody: false,
      kind: "hardNavigate",
      reason: "invalidRscPayload",
      url: "/error",
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.invalidRscPayload, {
      fetchResultSource: "live",
      redirectDepth: 0,
      targetHref: "/error",
    });
  });

  it("hard-navigates non-RSC content types as invalid payloads", () => {
    const decision = classify({
      isRscContentType: false,
      responseUrl: "https://example.com/html-error",
    });

    expect(decision).toMatchObject({
      discardBody: false,
      kind: "hardNavigate",
      reason: "invalidRscPayload",
      url: "/html-error",
    });
  });

  it("hard-navigates missing response bodies as invalid payloads", () => {
    const decision = classify({
      hasBody: false,
      responseUrl: null,
    });

    expect(decision).toMatchObject({
      discardBody: false,
      kind: "hardNavigate",
      reason: "invalidRscPayload",
      url: "/current",
    });
  });

  it("hard-navigates RSC compatibility mismatches before redirect classification", () => {
    const decision = classify({
      compatibilityIdHeader: "server-build",
      responseUrl: "https://example.com/redirected.rsc?_rsc=abc",
    });

    expect(decision).toMatchObject({
      discardBody: false,
      kind: "hardNavigate",
      reason: "rscCompatibilityMismatch",
      url: "/redirected",
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.rscCompatibilityMismatch, {
      fetchResultSource: "live",
      redirectDepth: 0,
      targetHref: "/redirected",
    });
  });

  it("follows live response-URL redirects and requires body discard", () => {
    const decision = classify({
      effectiveHistoryUpdateMode: "push",
      redirectDepth: 2,
      requestPreviousNextUrl: "/feed",
      responseUrl: "https://example.com/target.rsc?tab=1&_rsc=abc",
    });

    expect(decision).toEqual({
      discardBody: true,
      kind: "followRedirect",
      redirect: {
        href: "/target?tab=1",
        historyUpdateMode: "push",
        previousNextUrl: "/feed",
        redirectDepth: 3,
      },
      trace: {
        schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
        entries: [
          {
            code: NavigationTraceReasonCodes.redirectFollow,
            fields: {
              fetchResultSource: "live",
              redirectDepth: 3,
              redirectSignal: "response-url",
              targetHref: "/target?tab=1",
            },
          },
        ],
      },
    });
  });

  it("hard-navigates external response-URL redirect targets without discarding the body", () => {
    const decision = classify({
      responseUrl: "https://idp.example/login",
    });

    expect(decision).toMatchObject({
      discardBody: false,
      kind: "hardNavigate",
      reason: "externalRedirectTarget",
      url: "https://idp.example/login",
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.redirectTerminalExternal, {
      fetchResultSource: "live",
      redirectDepth: 0,
      redirectSignal: "response-url",
      targetHref: "https://idp.example/login",
    });
  });

  it("hard-navigates over-budget response-URL redirect chains without discarding the body", () => {
    const decision = classify({
      redirectDepth: 10,
      responseUrl: "https://example.com/target.rsc?_rsc=abc",
    });

    expect(decision).toMatchObject({
      discardBody: false,
      kind: "hardNavigate",
      reason: "redirectDepthExhausted",
      url: "/target",
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.redirectTerminalDepth, {
      fetchResultSource: "live",
      redirectDepth: 10,
      redirectSignal: "response-url",
      targetHref: "/target",
    });
  });

  it("follows streamed redirects and requires body discard", () => {
    const decision = classify({
      effectiveHistoryUpdateMode: "push",
      requestPreviousNextUrl: "/feed",
      responseUrl: "https://example.com/current.rsc?_rsc=abc",
      streamedRedirectTarget: "/streamed?tab=1#details",
    });

    expect(decision).toEqual({
      discardBody: true,
      kind: "followRedirect",
      redirect: {
        href: "/streamed?tab=1#details",
        historyUpdateMode: "push",
        previousNextUrl: "/feed",
        redirectDepth: 1,
      },
      trace: {
        schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
        entries: [
          {
            code: NavigationTraceReasonCodes.redirectFollow,
            fields: {
              fetchResultSource: "live",
              redirectDepth: 1,
              redirectSignal: "streamed-header",
              targetHref: "/streamed?tab=1#details",
            },
          },
        ],
      },
    });
  });

  it("hard-navigates external streamed redirects and requires body discard", () => {
    const decision = classify({
      streamedRedirectTarget: "https://idp.example/login#step",
    });

    expect(decision).toMatchObject({
      discardBody: true,
      kind: "hardNavigate",
      reason: "externalRedirectTarget",
      url: "https://idp.example/login#step",
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.redirectTerminalExternal, {
      fetchResultSource: "live",
      redirectDepth: 0,
      redirectSignal: "streamed-header",
      targetHref: "https://idp.example/login#step",
    });
  });

  it("hard-navigates over-budget streamed redirects and requires body discard", () => {
    const decision = classify({
      redirectDepth: 10,
      streamedRedirectTarget: "/streamed#details",
    });

    expect(decision).toMatchObject({
      discardBody: true,
      kind: "hardNavigate",
      reason: "redirectDepthExhausted",
      url: "/streamed#details",
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.redirectTerminalDepth, {
      fetchResultSource: "live",
      redirectDepth: 10,
      redirectSignal: "streamed-header",
      targetHref: "/streamed#details",
    });
  });

  it("hard-navigates same-target streamed redirects as loop guards", () => {
    const decision = classify({
      currentHref: "/same?tab=1#section",
      responseUrl: "https://example.com/same.rsc?tab=1&_rsc=abc#section",
      streamedRedirectTarget: "/same?tab=1#section",
    });

    expect(decision).toMatchObject({
      discardBody: true,
      kind: "hardNavigate",
      reason: "streamedRedirectLoop",
      url: "/same?tab=1#section",
    });
    expectSingleTraceEntry(decision, NavigationTraceReasonCodes.streamedRedirectLoop, {
      fetchResultSource: "live",
      redirectDepth: 0,
      redirectSignal: "streamed-header",
      targetHref: "/same?tab=1#section",
    });
  });

  it("preserves streamed redirect target hashes", () => {
    const decision = classify({
      currentHref: "/old#old",
      responseUrl: "https://example.com/old.rsc?_rsc=abc#old",
      streamedRedirectTarget: "/new#new",
    });

    expect(decision).toMatchObject({
      kind: "followRedirect",
      redirect: {
        href: "/new#new",
      },
    });
  });

  it("follows streamed hash-only redirects instead of treating them as loops", () => {
    const decision = classify({
      currentHref: "/same#old",
      responseUrl: "https://example.com/same.rsc?_rsc=abc#old",
      streamedRedirectTarget: "/same#new",
    });

    expect(decision).toMatchObject({
      kind: "followRedirect",
      redirect: {
        href: "/same#new",
      },
    });
  });

  it("preserves streamed visible query params and hashes", () => {
    const decision = classify({
      streamedRedirectTarget: "/target.rsc?visible=1&_rsc=abc#details",
    });

    expect(decision).toMatchObject({
      kind: "followRedirect",
      redirect: {
        href: "/target.rsc?visible=1&_rsc=abc#details",
      },
    });
  });

  it("proceeds to commit for valid non-redirect RSC responses", () => {
    const decision = classify();

    expect(decision).toEqual({
      discardBody: false,
      kind: "proceedToCommit",
      trace: {
        schemaVersion: NAVIGATION_TRACE_SCHEMA_VERSION,
        entries: [
          {
            code: NavigationTraceReasonCodes.proceedToCommit,
            fields: {
              fetchResultSource: "live",
            },
          },
        ],
      },
    });
  });

  it("keeps cached-source precedence at compat, redirect, then proceed", () => {
    const compatDecision = classify({
      compatibilityIdHeader: "server-build",
      source: "cached",
      responseUrl: "https://example.com/cached-target.rsc?_rsc=abc",
    });
    expect(compatDecision).toMatchObject({
      kind: "hardNavigate",
      reason: "rscCompatibilityMismatch",
      url: "/cached-target",
    });

    const redirectDecision = classify({
      source: "cached",
      responseUrl: "https://example.com/cached-target.rsc?_rsc=abc",
    });
    expect(redirectDecision).toMatchObject({
      discardBody: false,
      kind: "followRedirect",
      redirect: {
        href: "/cached-target",
      },
    });

    const proceedDecision = classify({
      source: "cached",
    });
    expect(proceedDecision).toMatchObject({
      kind: "proceedToCommit",
    });
  });
});
