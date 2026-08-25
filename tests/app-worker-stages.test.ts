import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleResponseStage } from "../packages/vinext/src/server/app-response-stage-entry.js";
import {
  APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
  isAppWorkerResponseStageProps,
  type AppWorkerResponseStageProps,
} from "../packages/vinext/src/server/app-worker-stages.js";

const stages = vi.hoisted(() => ({
  registerCacheAdapters: vi.fn(),
  registerImageOptimizer: vi.fn(),
  renderResponse: vi.fn(),
}));

vi.mock("virtual:vinext-cache-adapters", () => ({
  registerConfiguredCacheAdapters: stages.registerCacheAdapters,
}));

vi.mock("virtual:vinext-image-adapters", () => ({
  registerConfiguredImageOptimizer: stages.registerImageOptimizer,
}));

vi.mock("virtual:vinext-app-response-entry", () => ({
  default: { handleResponseStage: stages.renderResponse },
}));

const notFoundStage = {
  buildId: null,
  canonicalPathname: "/missing",
  cleanPathname: "/missing",
  draftModeCookie: null,
  isRscRequest: false,
  kind: "app-not-found" as const,
  middlewareCookieOverlay: null,
  mountedSlotsHeader: null,
  protocolVersion: APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
  renderMode: "navigation" as const,
  resolvedUrl: "/missing",
  scriptNonce: null,
} satisfies AppWorkerResponseStageProps;

describe("App Worker response stage", () => {
  beforeEach(() => {
    stages.registerCacheAdapters.mockReset();
    stages.registerImageOptimizer.mockReset();
    stages.renderResponse.mockReset();
  });

  it("re-enters the request stage through the adapter-owned reverse transport", async () => {
    const dispatchRequestStage = vi.fn(async () => new Response("revalidated"));
    stages.renderResponse.mockImplementationOnce(async (_request, ctx) =>
      ctx.dispatchPagesRevalidate(new Request("https://example.com/missing")),
    );

    const response = await handleResponseStage(
      new Request("https://example.com/missing"),
      { binding: "value" },
      undefined,
      notFoundStage,
      dispatchRequestStage,
      { cache: "shared" },
    );

    await expect(response.text()).resolves.toBe("revalidated");
    expect(dispatchRequestStage).toHaveBeenCalledOnce();
    expect(stages.renderResponse).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      notFoundStage,
      { cache: "shared" },
    );
  });

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

  it("requires a transport proof on full-request stage payloads", () => {
    const fullStage = {
      buildId: null,
      draftModeCookie: null,
      kind: "app-full-request" as const,
      middlewareCookieOverlay: null,
      protocolVersion: APP_WORKER_RESPONSE_STAGE_PROTOCOL_VERSION,
      scriptNonce: null,
      staticFileSignalToken: "00000000-0000-4000-8000-000000000000",
    } satisfies AppWorkerResponseStageProps;
    const { staticFileSignalToken: _token, ...withoutToken } = fullStage;

    expect(isAppWorkerResponseStageProps(fullStage)).toBe(true);
    expect(isAppWorkerResponseStageProps(withoutToken)).toBe(false);
  });
});
