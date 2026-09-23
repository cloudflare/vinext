import { describe, expect, it } from "vite-plus/test";
import {
  createAppMetadataModuleRoute,
  createGenerateMetadataSpanDescriptor,
} from "../packages/vinext/src/server/app-metadata-tracing.js";
import {
  resolveActiveParallelRouteHeadInputs,
  resolveAppPageHead,
} from "../packages/vinext/src/server/app-page-head.js";
import { registerFrameworkTracingIntegration } from "../packages/vinext/src/server/tracer.js";
import type { ResolvedFrameworkSpanDescriptor } from "../packages/vinext/src/server/framework-tracer.js";

const recordedDescriptors: ResolvedFrameworkSpanDescriptor[] = [];
registerFrameworkTracingIntegration({
  id: "app-metadata-tracing-test",
  enterSpan(descriptor, callback) {
    recordedDescriptors.push(descriptor);
    return callback({ setAttribute() {} });
  },
});

describe("App metadata tracing", () => {
  // Ported from Next.js: test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  it("matches the stable Next.js generateMetadata span descriptor", () => {
    expect(createGenerateMetadataSpanDescriptor("/app/[param]/page")).toEqual({
      attributes: {
        "next.page": "/app/[param]/page",
      },
      name: "generateMetadata /app/[param]/page",
      type: "ResolveMetadata.generateMetadata",
    });
  });

  it.each([
    { moduleType: "layout" as const, route: "/layout", segments: [] },
    {
      moduleType: "layout" as const,
      route: "/(group)/[param]/layout",
      segments: ["(group)", "[param]"],
    },
    {
      moduleType: "page" as const,
      route: "/app/[param]/page",
      segments: ["app", "[param]"],
    },
    {
      moduleType: "not-found" as const,
      route: "/app/[param]/not-found",
      segments: ["app", "[param]"],
    },
    { moduleType: "forbidden" as const, route: "/admin/forbidden", segments: ["admin"] },
    {
      moduleType: "unauthorized" as const,
      route: "/account/unauthorized",
      segments: ["account"],
    },
    {
      moduleType: "page" as const,
      route: "/[locale]/(.)photos/[photo]/page",
      segments: ["[locale]", "@modal", "(.)photos", "[photo]"],
    },
  ])("creates the $route module route", ({ moduleType, route, segments }) => {
    expect(createAppMetadataModuleRoute(segments, moduleType)).toBe(route);
  });

  it("retains the owner prefix for nested parallel route metadata spans", async () => {
    recordedDescriptors.length = 0;
    const generateMetadata = async () => null;
    const [input] = resolveActiveParallelRouteHeadInputs({
      layoutTreePositions: [0, 1],
      params: {},
      routeSegments: ["dashboard", "settings"],
      slots: {
        sidebar: {
          layout: { generateMetadata },
          layoutIndex: 1,
          page: { generateMetadata },
          routeSegments: ["members"],
        },
      },
    });

    await resolveAppPageHead({
      layoutModules: [],
      metadataRoutes: [],
      parallelRoutes: [input.head],
      params: {},
      routePath: "/dashboard/settings",
      routeSegments: ["dashboard", "settings"],
    });

    expect(
      recordedDescriptors
        .filter(({ type }) => type === "ResolveMetadata.generateMetadata")
        .map(({ attributes }) => attributes["next.page"]),
    ).toEqual(["/dashboard/layout", "/dashboard/members/page"]);
  });

  it("uses the owner route for an inactive nested slot layout span", async () => {
    recordedDescriptors.length = 0;
    const [input] = resolveActiveParallelRouteHeadInputs({
      layoutTreePositions: [0, 1],
      params: {},
      routeSegments: ["dashboard", "settings"],
      slots: {
        sidebar: {
          layout: { generateMetadata: async () => null },
          layoutIndex: 1,
        },
      },
    });
    expect(input.head.routeSegments).toEqual(["dashboard", "settings"]);

    await resolveAppPageHead({
      layoutModules: [],
      metadataRoutes: [],
      parallelRoutes: [input.head],
      params: {},
      routePath: "/dashboard/settings",
      routeSegments: ["dashboard", "settings"],
    });

    expect(
      recordedDescriptors
        .filter(({ type }) => type === "ResolveMetadata.generateMetadata")
        .map(({ attributes }) => attributes["next.page"]),
    ).toEqual(["/dashboard/layout"]);
  });
});
