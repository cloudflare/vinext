import { frameworkTracer } from "./tracer.js";

type AppMetadataModuleType = "forbidden" | "layout" | "not-found" | "page" | "unauthorized";

export function createAppMetadataModuleRoute(
  routeSegments: readonly string[],
  moduleType: AppMetadataModuleType,
): string {
  return `/${[...routeSegments.filter((segment) => !segment.startsWith("@")), moduleType].join("/")}`;
}

export function traceGenerateMetadata<T>(moduleRoute: string, callback: () => T): T {
  return frameworkTracer.trace(createGenerateMetadataSpanDescriptor(moduleRoute), callback);
}

export function createGenerateMetadataSpanDescriptor(moduleRoute: string) {
  return {
    attributes: { "next.page": moduleRoute },
    name: `generateMetadata ${moduleRoute}`,
    type: "ResolveMetadata.generateMetadata",
  } as const;
}
