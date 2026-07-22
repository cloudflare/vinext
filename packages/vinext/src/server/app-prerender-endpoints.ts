import { callAppPrerenderStaticParams } from "./app-prerender-static-params.js";
import {
  VINEXT_PRERENDER_PAGES_STATIC_PATHS_PATH,
  VINEXT_PRERENDER_STATIC_PARAMS_PATH,
} from "./headers.js";
import { notFoundResponse } from "./http-error-responses.js";
import type { RootParams } from "vinext/shims/root-params";

type GenerateStaticParams = (args: { params: RootParams }) => unknown;

export type AppPrerenderStaticParamsMap = Record<string, GenerateStaticParams | null | undefined>;
export type AppPrerenderRootParamNamesMap = Record<string, readonly string[] | undefined>;

type AppPrerenderPageRoute = {
  pattern: string;
  module?: {
    getStaticPaths?: (opts: { locales: string[]; defaultLocale: string }) => unknown;
  };
};

type HandleAppPrerenderEndpointOptions = {
  isPrerenderEnabled?: () => boolean;
  loadPagesRoutes?: () => Promise<unknown>;
  pathname: string;
  rootParamNamesByPattern?: AppPrerenderRootParamNamesMap;
  staticParamsMap: AppPrerenderStaticParamsMap;
};

const JSON_HEADERS = { "content-type": "application/json" };

export async function handleAppPrerenderEndpoint(
  request: Request,
  options: HandleAppPrerenderEndpointOptions,
): Promise<Response | null> {
  if (options.pathname === VINEXT_PRERENDER_STATIC_PARAMS_PATH) {
    return handleStaticParamsEndpoint(request, options);
  }

  if (options.pathname === VINEXT_PRERENDER_PAGES_STATIC_PATHS_PATH) {
    if (!options.loadPagesRoutes) return null;
    return handlePagesStaticPathsEndpoint(request, options);
  }

  return null;
}

async function handleStaticParamsEndpoint(
  request: Request,
  options: HandleAppPrerenderEndpointOptions,
): Promise<Response> {
  if (!isEnabled(options)) {
    return notFoundResponse();
  }

  const url = new URL(request.url);
  const pattern = url.searchParams.get("pattern");
  if (!pattern) return new Response("missing pattern", { status: 400 });

  const generateStaticParams = options.staticParamsMap[pattern];
  if (typeof generateStaticParams !== "function") {
    return jsonNullResponse();
  }

  try {
    const params = parseParentParams(url.searchParams.get("parentParams"));
    const result = await callAppPrerenderStaticParams({
      fn: generateStaticParams,
      params,
      pattern,
      rootParamNamesByPattern: options.rootParamNamesByPattern ?? {},
    });
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
}

async function handlePagesStaticPathsEndpoint(
  request: Request,
  options: HandleAppPrerenderEndpointOptions,
): Promise<Response> {
  if (!isEnabled(options)) {
    return notFoundResponse();
  }

  const url = new URL(request.url);
  const pattern = url.searchParams.get("pattern");
  if (!pattern) return new Response("missing pattern", { status: 400 });

  try {
    const pageRoutes = await options.loadPagesRoutes?.();
    const route = findPageRoute(pageRoutes, pattern);
    const getStaticPaths = route?.module?.getStaticPaths;
    if (typeof getStaticPaths !== "function") {
      return jsonNullResponse();
    }

    const locales = parseLocales(url.searchParams.get("locales"));
    const defaultLocale = url.searchParams.get("defaultLocale") ?? "";
    const result = await getStaticPaths({ locales, defaultLocale });
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({ error: String(error) }, 500);
  }
}

function isEnabled(options: HandleAppPrerenderEndpointOptions): boolean {
  return options.isPrerenderEnabled?.() ?? false;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: JSON_HEADERS,
    status,
  });
}

function jsonNullResponse(): Response {
  return new Response("null", {
    headers: JSON_HEADERS,
    status: 200,
  });
}

function parseParentParams(raw: string | null): RootParams {
  if (!raw) return {};

  const value = JSON.parse(raw);
  if (!isPlainObject(value)) return {};

  const params: RootParams = {};
  for (const [key, paramValue] of Object.entries(value)) {
    if (typeof paramValue === "string" || paramValue === undefined || isStringArray(paramValue)) {
      params[key] = paramValue;
    }
  }
  return params;
}

function parseLocales(raw: string | null): string[] {
  if (!raw) return [];

  const value = JSON.parse(raw);
  if (!Array.isArray(value)) return [];

  return value.filter((locale) => typeof locale === "string");
}

function findPageRoute(value: unknown, pattern: string): AppPrerenderPageRoute | undefined {
  if (!Array.isArray(value)) return undefined;

  for (const route of value) {
    if (isPageRoute(route) && route.pattern === pattern) {
      return route;
    }
  }

  return undefined;
}

function isPageRoute(value: unknown): value is AppPrerenderPageRoute {
  if (!isPlainObject(value) || typeof value.pattern !== "string") return false;
  if (value.module === undefined) return true;
  if (!isPlainObject(value.module)) return false;

  return (
    value.module.getStaticPaths === undefined || typeof value.module.getStaticPaths === "function"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
