import type { HeadersContext } from "vinext/shims/headers";

type AppStaticGenerationRouteKind = "page" | "route";

type CreateStaticGenerationHeadersContextOptions = {
  dynamicConfig?: string;
  routeKind: AppStaticGenerationRouteKind;
  routePattern?: string;
};

export function getAppPageStaticGenerationErrorMessage(): string {
  return (
    'Page with `dynamic = "error"` used a dynamic API. ' +
    "This page was expected to be fully static, but headers(), cookies(), " +
    "or searchParams was accessed. Remove the dynamic API usage or change " +
    'the dynamic config to "auto" or "force-dynamic".'
  );
}

export function getAppRouteStaticGenerationErrorMessage(
  routePattern?: string,
  expression?: string,
): string {
  const route = routePattern ?? "unknown route";
  const dynamicExpression = expression ?? "a dynamic request API";
  return (
    `Route ${route} with \`dynamic = "error"\` couldn't be rendered statically ` +
    `because it used ${dynamicExpression}. ` +
    "See more info here: https://nextjs.org/docs/app/building-your-application/rendering/static-and-dynamic#dynamic-rendering"
  );
}

export function createStaticGenerationHeadersContext(
  options: CreateStaticGenerationHeadersContextOptions,
): HeadersContext {
  const context: HeadersContext = {
    headers: new Headers(),
    cookies: new Map(),
  };

  if (options.dynamicConfig === "force-static") {
    context.forceStatic = true;
  }

  if (options.dynamicConfig === "error") {
    context.accessError = new Error(
      options.routeKind === "route"
        ? getAppRouteStaticGenerationErrorMessage(options.routePattern)
        : getAppPageStaticGenerationErrorMessage(),
    );
  }

  return context;
}
