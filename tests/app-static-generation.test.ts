import { describe, expect, it } from "vitest";
import {
  createStaticGenerationHeadersContext,
  getAppPageStaticGenerationErrorMessage,
  getAppRouteStaticGenerationErrorMessage,
} from "../packages/vinext/src/server/app-static-generation.js";

describe("app static generation helpers", () => {
  it("builds a force-static headers context without request data", () => {
    const context = createStaticGenerationHeadersContext({
      dynamicConfig: "force-static",
      routeKind: "page",
      routePattern: "/profile",
    });

    expect(Array.from(context.headers)).toEqual([]);
    expect(Array.from(context.cookies)).toEqual([]);
    expect(context.forceStatic).toBe(true);
    expect(context.accessError).toBeUndefined();
  });

  it("builds a page dynamic-error context with the page message", () => {
    const context = createStaticGenerationHeadersContext({
      dynamicConfig: "error",
      routeKind: "page",
      routePattern: "/profile",
    });

    expect(context.forceStatic).toBeUndefined();
    expect(context.accessError?.message).toBe(getAppPageStaticGenerationErrorMessage());
  });

  it("builds a route dynamic-error context with the route expression message", () => {
    const message = getAppRouteStaticGenerationErrorMessage("/api/profile", "request.headers");
    const context = createStaticGenerationHeadersContext({
      dynamicConfig: "error",
      routeKind: "route",
      routePattern: "/api/profile",
    });

    expect(message).toContain("Route /api/profile");
    expect(message).toContain("request.headers");
    expect(context.accessError?.message).toBe(
      getAppRouteStaticGenerationErrorMessage("/api/profile"),
    );
  });
});
