import { describe, expect, it } from "vite-plus/test";
import {
  APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
  isAppWorkerResponseStageProps,
  prepareSharedAppPageDispatch,
  type AppWorkerResponseStageProps,
} from "../packages/vinext/src/server/app-worker-stages.js";

const notFoundStage = {
  buildId: null,
  cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/missing" },
  canonicalPathname: "/missing",
  cleanPathname: "/missing",
  draftModeCookie: null,
  isRscRequest: false,
  kind: "app-not-found" as const,
  middlewareCookieOverlay: null,
  mountedSlotsHeader: null,
  protocolVersion: APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
  requestOrigin: "https://example.com",
  renderMode: "navigation" as const,
  resolvedUrl: "/missing",
  scriptNonce: null,
} satisfies AppWorkerResponseStageProps;

describe("App Worker response-stage protocol", () => {
  it("rejects matched-stage payloads missing interception cache-safety fields", () => {
    const matchedStage = {
      ...notFoundStage,
      bypassInterceptionContextCache: false,
      interceptionContext: null,
      interceptionId: null,
      kind: "app-page" as const,
      matchKind: "request" as const,
      params: {},
      routePattern: "/missing",
      routePathname: "/missing",
    } satisfies AppWorkerResponseStageProps;
    const { bypassInterceptionContextCache: _bypass, ...withoutBypassProof } = matchedStage;
    const { interceptionId: _interceptionId, ...withoutInterceptionId } = matchedStage;

    expect(isAppWorkerResponseStageProps(matchedStage)).toBe(true);
    expect(isAppWorkerResponseStageProps(withoutBypassProof)).toBe(false);
    expect(isAppWorkerResponseStageProps(withoutInterceptionId)).toBe(false);
  });

  it.each([
    { name: "missing", requestOrigin: undefined },
    { name: "relative", requestOrigin: "example.com" },
    { name: "non-HTTP", requestOrigin: "ftp://example.com" },
    { name: "non-canonical", requestOrigin: "https://example.com/" },
  ])("rejects a $name request origin", ({ requestOrigin }) => {
    expect(isAppWorkerResponseStageProps({ ...notFoundStage, requestOrigin })).toBe(false);
  });

  it("requires a transport proof on full-request stage payloads", () => {
    const fullStage = {
      buildId: null,
      cacheability: { policyHeaders: null, probeMode: null, resolvedRoutePathname: "/" },
      draftModeCookie: null,
      kind: "app-full-request" as const,
      middlewareCookieOverlay: null,
      prerenderDiscovery: false,
      protocolVersion: APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
      requestOrigin: "https://example.com",
      scriptNonce: null,
      staticFileSignalToken: "00000000-0000-4000-8000-000000000000",
      trustedPrerenderState: null,
    } satisfies AppWorkerResponseStageProps;
    const { staticFileSignalToken: _token, ...withoutToken } = fullStage;

    expect(isAppWorkerResponseStageProps(fullStage)).toBe(true);
    expect(isAppWorkerResponseStageProps(withoutToken)).toBe(false);
  });

  it("normalizes shared HEAD page dispatches without changing bypassed work", () => {
    const request = new Request("https://example.com/page", { method: "HEAD" });

    expect(prepareSharedAppPageDispatch(request, "shared").method).toBe("GET");
    expect(prepareSharedAppPageDispatch(request, "bypass")).toBe(request);
  });
});
