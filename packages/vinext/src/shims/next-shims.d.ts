// oxlint-disable typescript/no-explicit-any
/**
 * Type declarations for next/* bare specifiers used within shims.
 *
 * These resolve via Vite's resolve.alias at runtime. This file
 * satisfies TypeScript when one shim imports another (e.g. link -> router).
 */

declare module "next" {
  import type { IncomingMessage, ServerResponse } from "node:http";
  type Env = { [key: string]: string | undefined };
  export type PreviewData = string | false | object | undefined;
  // oxlint-disable-next-line typescript/consistent-type-definitions
  export interface NextApiRequest extends IncomingMessage {
    query: Partial<{ [key: string]: string | string[] }>;
    cookies: Partial<{ [key: string]: string }>;
    body: any;
    env: Env;
    draftMode?: boolean;
    preview?: boolean;
    previewData?: PreviewData;
  }
  export type NextApiResponse<Data = any> = ServerResponse & {
    send: (body: Data) => void;
    json: (body: Data) => void;
    status: (statusCode: number) => NextApiResponse<Data>;
    redirect(url: string): NextApiResponse<Data>;
    redirect(status: number, url: string): NextApiResponse<Data>;
    setDraftMode: (options: { enable: boolean }) => NextApiResponse<Data>;
    setPreviewData(
      data: object | string,
      options?: { maxAge?: number; path?: string },
    ): NextApiResponse<Data>;
    clearPreviewData(options?: { path?: string }): NextApiResponse<Data>;
    revalidate(urlPath: string, opts?: { unstable_onlyGenerated?: boolean }): Promise<void>;
  };
  export type NextApiHandler<T = any> = (
    req: NextApiRequest,
    res: NextApiResponse<T>,
    // oxlint-disable-next-line typescript/no-redundant-type-constituents
  ) => unknown | Promise<unknown>;
}

declare module "next/router" {
  import { ComponentType } from "react";
  export function useRouter(): any;
  export function setSSRContext(ctx: any): void;
  export type WithRouterProps = { router: any };
  export type ExcludeRouterProps<P> = Pick<P, Exclude<keyof P, keyof WithRouterProps>>;
  export type TransitionOptions = {
    shallow?: boolean;
    scroll?: boolean;
    locale?: string | false;
  };
  export function withRouter<P extends WithRouterProps>(
    ComposedComponent: ComponentType<P>,
  ): ComponentType<ExcludeRouterProps<P>>;
  const Router: {
    push(url: string | object, as?: string, options?: TransitionOptions): Promise<boolean>;
    replace(url: string | object, as?: string, options?: TransitionOptions): Promise<boolean>;
    back(): void;
    reload(): void;
    prefetch(url: string): Promise<void>;
    events: any;
  };
  export default Router;
}

declare module "next/head" {
  import { ComponentType, ReactNode } from "react";
  const Head: ComponentType<{ children?: ReactNode }>;
  export default Head;
  export function resetSSRHead(): void;
  export function getSSRHeadHTML(): string;
}

declare module "next/document" {
  import { Component, ComponentType, ReactElement, ReactNode } from "react";
  export const Html: ComponentType<{ lang?: string; children?: ReactNode; [key: string]: unknown }>;
  export const Head: ComponentType<{ children?: ReactNode }>;
  export const Main: ComponentType;
  export const NextScript: ComponentType;
  export type DocumentInitialProps = {
    html: string;
    head?: ReadonlyArray<ReactElement>;
    styles?: ReactElement[] | Iterable<ReactNode> | ReactElement;
  };
  export type DocumentContext = {
    renderPage: (
      options?:
        | {
            enhanceApp?: (
              App: ComponentType<{ children?: ReactNode }>,
            ) => ComponentType<{ children?: ReactNode }>;
            enhanceComponent?: (Comp: ComponentType<unknown>) => ComponentType<unknown>;
          }
        | ((Comp: ComponentType<unknown>) => ComponentType<unknown>),
    ) => DocumentInitialProps | Promise<DocumentInitialProps>;
    defaultGetInitialProps: (
      ctx: DocumentContext,
      options?: { nonce?: string },
    ) => Promise<DocumentInitialProps>;
    pathname?: string;
    query?: Record<string, string | string[] | undefined>;
    asPath?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    err?: any;
  };
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export default class Document<P = {}> extends Component<P & { children?: ReactNode }> {
    static getInitialProps(ctx: DocumentContext): Promise<DocumentInitialProps>;
    render(): ReactNode;
  }
}

declare module "next/dynamic" {
  import { ComponentType } from "react";
  type DynamicOptionsLoadingProps = {
    error?: Error | null;
    isLoading?: boolean;
    pastDelay?: boolean;
    retry?: () => void;
    timedOut?: boolean;
  };
  function dynamic<P extends object = object>(
    loader: () => Promise<{ default: ComponentType<P> } | ComponentType<P>>,
    options?: { loading?: ComponentType<DynamicOptionsLoadingProps>; ssr?: boolean },
  ): ComponentType<P>;
  export default dynamic;
  export function flushPreloads(): Promise<void[]>;
}

declare module "next/config" {
  type RuntimeConfig = {
    serverRuntimeConfig: Record<string, unknown>;
    publicRuntimeConfig: Record<string, unknown>;
  };
  export default function getConfig(): RuntimeConfig;
  export function setConfig(configValue: RuntimeConfig): void;
}

declare module "next/script" {
  import { ReactElement } from "react";
  type ScriptProps = {
    src?: string;
    strategy?: "beforeInteractive" | "afterInteractive" | "lazyOnload" | "worker";
    id?: string;
    onLoad?: (e: Event) => void;
    onReady?: () => void;
    onError?: (e: Event) => void;
    children?: React.ReactNode;
    dangerouslySetInnerHTML?: { __html: string };
    [key: string]: unknown;
  };
  const Script: (props: ScriptProps) => ReactElement | null;
  export default Script;
  export { ScriptProps };
  export function handleClientScriptLoad(props: ScriptProps): void;
  export function initScriptLoader(scripts: ScriptProps[]): void;
}

declare module "next/headers" {
  export function headers(): Promise<Headers>;
  export function cookies(): Promise<any>;
  export function draftMode(): Promise<{ isEnabled: boolean }>;
}

declare module "next/link" {
  import { ComponentType, AnchorHTMLAttributes, ReactNode } from "react";
  type UrlQueryValue = string | number | boolean | null | undefined;
  type UrlQuery = Record<string, UrlQueryValue | readonly UrlQueryValue[]>;
  type LinkProps = {
    href: string | { pathname?: string; query?: UrlQuery };
    as?: string;
    replace?: boolean;
    prefetch?: boolean | "auto" | null;
    unstable_dynamicOnHover?: boolean;
    passHref?: boolean;
    scroll?: boolean;
    locale?: string | false;
    onNavigate?: (event: { preventDefault(): void }) => void;
    children?: ReactNode;
  } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;
  const Link: ComponentType<LinkProps>;
  export default Link;
}

declare module "next/navigation" {
  export function useRouter(): {
    bfcacheId: string;
    push(href: string, options?: { scroll?: boolean }): void;
    replace(href: string, options?: { scroll?: boolean }): void;
    back(): void;
    forward(): void;
    refresh(): void;
    prefetch(href: string, options?: { onInvalidate?: () => void }): void;
  };
  export function usePathname(): string | null;
  export class ReadonlyURLSearchParams extends URLSearchParams {
    append(name: string, value: string): never;
    delete(name: string, value?: string): never;
    set(name: string, value: string): never;
    sort(): never;
  }
  export function useSearchParams(): ReadonlyURLSearchParams;
  export function useParams<
    T extends Record<string, string | string[]> = Record<string, string | string[]>,
  >(): T | null;
  export function useSelectedLayoutSegment(parallelRoutesKey?: string): string | null;
  export function useSelectedLayoutSegments(parallelRoutesKey?: string): string[];
  export function useServerInsertedHTML(callback: () => unknown): void;
  export const ServerInsertedHTMLContext:
    | import("react").Context<((callback: () => unknown) => void) | null>
    | null;
  export enum RedirectType {
    push = "push",
    replace = "replace",
  }
  export function redirect(url: string, type?: "replace" | "push" | RedirectType): never;
  export function permanentRedirect(url: string): never;
  export function notFound(): never;
  export function forbidden(): never;
  export function unauthorized(): never;
  export const HTTP_ERROR_FALLBACK_ERROR_CODE: string;
  export function isHTTPAccessFallbackError(error: unknown): boolean;
  export function getAccessFallbackHTTPStatus(error: unknown): number;
  export function isRedirectError(error: unknown): error is Error & { digest: string };
  export function isNextRouterError(error: unknown): boolean;
  export class BailoutToCSRError extends Error {
    readonly digest: "BAILOUT_TO_CLIENT_SIDE_RENDERING";
    readonly reason: string;
    constructor(reason: string);
  }
  export function isBailoutToCSRError(error: unknown): error is BailoutToCSRError;
  export class DynamicServerError extends Error {
    readonly digest: "DYNAMIC_SERVER_USAGE";
    readonly description: string;
    constructor(description: string);
  }
  export function isDynamicServerError(error: unknown): error is DynamicServerError;
  export function unstable_rethrow(error: unknown): void;
  export class UnrecognizedActionError extends Error {}
  export function unstable_isUnrecognizedActionError(
    error: unknown,
  ): error is UnrecognizedActionError;
  // Context management (internal)
  export function setNavigationContext(ctx: any): void;
  export function setClientParams(params: Record<string, string | string[]>): void;
  export function getClientParams(): Record<string, string | string[]>;
  export function getLayoutSegmentContext(): import("react").Context<string[]> | null;

  // RSC prefetch cache utilities (shared between link.tsx and browser entry)
  export type CachedRscResponse = {
    compatibilityIdHeader?: string | null;
    buffer: ArrayBuffer;
    contentType: string;
    dynamicStaleTimeSeconds?: number;
    expiresAt?: number;
    mountedSlotsHeader?: string | null;
    paramsHeader: string | null;
    renderedPathAndSearch: string | null;
    url: string;
  };
  export type PrefetchCacheEntry = {
    cacheForNavigation?: boolean;
    expiresAt?: number;
    invalidationTimer?: ReturnType<typeof setTimeout>;
    mountedSlotsHeader?: string | null;
    onInvalidateCallbacks?: Set<() => void>;
    optimisticRouteShell?: boolean;
    outcome: "pending" | "cache-seeded";
    snapshot?: CachedRscResponse;
    cacheKeys?: Set<string>;
    pending?: Promise<void>;
    prefetchKind?: "loading-shell" | "navigation" | "route-tree";
    searchAgnosticShell?: boolean;
    timestamp: number;
  };
  export const MAX_PREFETCH_CACHE_SIZE: number;
  export const PREFETCH_CACHE_TTL: number;
  export const DYNAMIC_NAVIGATION_CACHE_TTL: number;
  export function getPrefetchInterceptionContext(targetHref: string): string | null;
  export function getPrefetchCache(): Map<string, PrefetchCacheEntry>;
  export function getPrefetchedUrls(): Set<string>;
  export function invalidatePrefetchCache(): void;
  export function resolvePrefetchCacheEntryMountedSlotsHeader(
    entry: PrefetchCacheEntry,
  ): string | null;
  export function hasPrefetchCacheEntryForNavigation(
    rscUrl: string,
    interceptionContext?: string | null,
    mountedSlotsHeader?: string | null,
    options?: { notifyInvalidation?: boolean },
  ): boolean;
  export function hasSearchAgnosticPrefetchShellForRoute(
    rscUrl: string,
    interceptionContext?: string | null,
    mountedSlotsHeader?: string | null,
  ): boolean;
  export function peekPrefetchResponseForNavigation(
    rscUrl: string,
    interceptionContext?: string | null,
    mountedSlotsHeader?: string | null,
  ): CachedRscResponse | null;
  export function storePrefetchResponse(
    rscUrl: string,
    response: Response,
    interceptionContext?: string | null,
    options?: { onInvalidate?: () => void },
  ): void;
  export function seedPrefetchResponseSnapshot(
    rscUrl: string,
    snapshot: CachedRscResponse,
    interceptionContext?: string | null,
    mountedSlotsHeader?: string | null,
    fallbackTtlMs?: number,
  ): void;
  export function snapshotRscResponse(response: Response): Promise<CachedRscResponse>;
  export function restoreRscResponse(cached: CachedRscResponse, copy?: boolean): Response;
  export function prefetchRscResponse(
    rscUrl: string,
    fetchPromise: Promise<Response>,
    interceptionContext?: string | null,
    mountedSlotsHeader?: string | null,
    options?: { onInvalidate?: () => void },
    behavior?: {
      cacheForNavigation?: boolean;
      fallbackTtlMs?: number;
      optimisticRouteShell?: boolean;
      prefetchKind?: "loading-shell" | "navigation" | "route-tree";
    },
  ): void;
  export function consumePrefetchResponse(
    rscUrl: string,
    interceptionContext?: string | null,
    mountedSlotsHeader?: string | null,
  ): CachedRscResponse | null;
  export function consumePrefetchResponseForNavigation(
    rscUrl: string,
    interceptionContext?: string | null,
    mountedSlotsHeader?: string | null,
    options?: { shouldConsume?: () => boolean },
  ): Promise<CachedRscResponse | null>;
}

declare module "next/image" {
  import {
    ForwardRefExoticComponent,
    RefAttributes,
    ImgHTMLAttributes,
    CSSProperties,
    ReactEventHandler,
    MouseEventHandler,
  } from "react";

  export type StaticImageData = {
    src: string;
    height: number;
    width: number;
    blurDataURL?: string;
  };

  type ImageProps = {
    src: string | StaticImageData;
    alt: string;
    width?: number;
    height?: number;
    fill?: boolean;
    priority?: boolean;
    quality?: number;
    placeholder?: "blur" | "empty";
    blurDataURL?: string;
    loader?: (params: { src: string; width: number; quality?: number }) => string;
    sizes?: string;
    className?: string;
    style?: CSSProperties;
    onLoad?: ReactEventHandler<HTMLImageElement>;
    /** @deprecated Use onLoad instead. Still supported for migration compat. */
    onLoadingComplete?: (img: HTMLImageElement) => void;
    onError?: ReactEventHandler<HTMLImageElement>;
    onClick?: MouseEventHandler<HTMLImageElement>;
    id?: string;
    unoptimized?: boolean;
    overrideSrc?: string;
    loading?: "lazy" | "eager";
  };

  const Image: ForwardRefExoticComponent<ImageProps & RefAttributes<HTMLImageElement>>;
  export default Image;

  export function getImageProps(props: ImageProps): {
    props: ImgHTMLAttributes<HTMLImageElement>;
  };
}

declare module "next/legacy/image" {
  import {
    ForwardRefExoticComponent,
    RefAttributes,
    CSSProperties,
    ReactEventHandler,
  } from "react";

  type LegacyImageProps = {
    src: string | { src: string; width: number; height: number; blurDataURL?: string };
    alt: string;
    width?: number | string;
    height?: number | string;
    layout?: "fixed" | "intrinsic" | "responsive" | "fill";
    objectFit?: CSSProperties["objectFit"];
    objectPosition?: string;
    priority?: boolean;
    quality?: number;
    placeholder?: "blur" | "empty";
    blurDataURL?: string;
    loader?: (params: { src: string; width: number; quality?: number }) => string;
    sizes?: string;
    className?: string;
    style?: CSSProperties;
    onLoad?: ReactEventHandler<HTMLImageElement>;
    onLoadingComplete?: (result: { naturalWidth: number; naturalHeight: number }) => void;
    onError?: ReactEventHandler<HTMLImageElement>;
    loading?: "lazy" | "eager";
    unoptimized?: boolean;
    id?: string;
  };

  const LegacyImage: ForwardRefExoticComponent<LegacyImageProps & RefAttributes<HTMLImageElement>>;
  export default LegacyImage;
}

declare module "next/error" {
  import { ComponentType, ReactNode } from "react";

  type ErrorProps = {
    statusCode: number;
    title?: string;
    withDarkMode?: boolean;
  };

  const ErrorComponent: ComponentType<ErrorProps>;
  export default ErrorComponent;

  export type ErrorInfo = {
    error: unknown;
    reset: () => void;
    unstable_retry: () => void;
  };

  export function unstable_catchError<P extends Record<string, unknown>>(
    fallback: (props: P, errorInfo: ErrorInfo) => ReactNode,
  ): ComponentType<P & { children?: ReactNode }>;
}

declare module "next/constants" {
  export const MODERN_BROWSERSLIST_TARGET: string[];

  export type ValueOf<T> = Required<T>[keyof T];

  export const COMPILER_NAMES: {
    client: "client";
    server: "server";
    edgeServer: "edge-server";
  };

  export type CompilerNameValues = ValueOf<typeof COMPILER_NAMES>;

  export const COMPILER_INDEXES: Record<CompilerNameValues, number>;

  export const UNDERSCORE_NOT_FOUND_ROUTE: string;
  export const UNDERSCORE_NOT_FOUND_ROUTE_ENTRY: string;
  export const UNDERSCORE_GLOBAL_ERROR_ROUTE: string;
  export const UNDERSCORE_GLOBAL_ERROR_ROUTE_ENTRY: string;

  export enum AdapterOutputType {
    PAGES = "PAGES",
    PAGES_API = "PAGES_API",
    APP_PAGE = "APP_PAGE",
    APP_ROUTE = "APP_ROUTE",
    PRERENDER = "PRERENDER",
    STATIC_FILE = "STATIC_FILE",
    MIDDLEWARE = "MIDDLEWARE",
  }

  export const PHASE_PRODUCTION_BUILD: "phase-production-build";
  export const PHASE_DEVELOPMENT_SERVER: "phase-development-server";
  export const PHASE_PRODUCTION_SERVER: "phase-production-server";
  export const PHASE_EXPORT: "phase-export";
  export const PHASE_INFO: "phase-info";
  export const PHASE_TEST: "phase-test";
  export const PHASE_ANALYZE: "phase-analyze";

  export type PHASE_TYPE =
    | typeof PHASE_INFO
    | typeof PHASE_TEST
    | typeof PHASE_EXPORT
    | typeof PHASE_ANALYZE
    | typeof PHASE_PRODUCTION_BUILD
    | typeof PHASE_PRODUCTION_SERVER
    | typeof PHASE_DEVELOPMENT_SERVER;

  export const PAGES_MANIFEST: string;
  export const APP_PATHS_MANIFEST: string;
  export const APP_PATH_ROUTES_MANIFEST: string;
  export const BUILD_MANIFEST: string;
  export const FUNCTIONS_CONFIG_MANIFEST: string;
  export const SUBRESOURCE_INTEGRITY_MANIFEST: string;
  export const NEXT_FONT_MANIFEST: string;
  export const EXPORT_MARKER: string;
  export const EXPORT_DETAIL: string;
  export const PREFETCH_HINTS: string;
  export const PRERENDER_MANIFEST: string;
  export const ROUTES_MANIFEST: string;
  export const IMAGES_MANIFEST: string;
  export const SERVER_FILES_MANIFEST: string;
  export const DEV_CLIENT_PAGES_MANIFEST: string;
  export const MIDDLEWARE_MANIFEST: string;
  export const TURBOPACK_CLIENT_MIDDLEWARE_MANIFEST: string;
  export const TURBOPACK_CLIENT_BUILD_MANIFEST: string;
  export const DEV_CLIENT_MIDDLEWARE_MANIFEST: string;
  export const REACT_LOADABLE_MANIFEST: string;
  export const SERVER_DIRECTORY: string;
  export const CONFIG_FILES: string[];
  export const BUILD_ID_FILE: string;
  export const BLOCKED_PAGES: string[];
  export const CLIENT_PUBLIC_FILES_PATH: string;
  export const CLIENT_STATIC_FILES_PATH: string;
  export const STRING_LITERAL_DROP_BUNDLE: string;
  export const NEXT_BUILTIN_DOCUMENT: string;
  export const BARREL_OPTIMIZATION_PREFIX: string;
  export const CLIENT_REFERENCE_MANIFEST: string;
  export const SERVER_REFERENCE_MANIFEST: string;
  export const MIDDLEWARE_BUILD_MANIFEST: string;
  export const MIDDLEWARE_REACT_LOADABLE_MANIFEST: string;
  export const INTERCEPTION_ROUTE_REWRITE_MANIFEST: string;
  export const DYNAMIC_CSS_MANIFEST: string;
  export const CLIENT_STATIC_FILES_RUNTIME_MAIN: string;
  export const CLIENT_STATIC_FILES_RUNTIME_MAIN_APP: string;
  export const APP_CLIENT_INTERNALS: string;
  export const CLIENT_STATIC_FILES_RUNTIME_REACT_REFRESH: string;
  export const CLIENT_STATIC_FILES_RUNTIME_WEBPACK: string;
  export const CLIENT_STATIC_FILES_RUNTIME_POLYFILLS: string;
  export const CLIENT_STATIC_FILES_RUNTIME_POLYFILLS_SYMBOL: symbol;
  export const DEFAULT_RUNTIME_WEBPACK: string;
  export const EDGE_RUNTIME_WEBPACK: string;
  export const STATIC_PROPS_ID: string;
  export const SERVER_PROPS_ID: string;
  export const DEFAULT_SERIF_FONT: {
    name: string;
    xAvgCharWidth: number;
    azAvgWidth: number;
    unitsPerEm: number;
  };
  export const DEFAULT_SANS_SERIF_FONT: {
    name: string;
    xAvgCharWidth: number;
    azAvgWidth: number;
    unitsPerEm: number;
  };
  export const STATIC_STATUS_PAGES: string[];
  export const TRACE_OUTPUT_VERSION: number;
  export const TURBO_TRACE_DEFAULT_MEMORY_LIMIT: number;
  export const RSC_MODULE_TYPES: {
    client: "client";
    server: "server";
  };
  export const EDGE_UNSUPPORTED_NODE_APIS: string[];
  export const SYSTEM_ENTRYPOINTS: Set<string>;
}

declare module "next/compat/router" {
  import type { NextRouter } from "./router.js";
  // oxlint-disable-next-line no-redundant-type-constituents -- NextRouter is a proper interface, not an error type
  export function useRouter(): NextRouter | null;
}

declare module "next/server" {
  export class NextRequest extends Request {
    readonly __isData?: boolean;
    get nextUrl(): any;
    get cookies(): any;
    get ip(): string | undefined;
    get geo():
      | { city?: string; country?: string; region?: string; latitude?: string; longitude?: string }
      | undefined;
  }
  export class NextResponse<Body = unknown> extends Response {
    get cookies(): any;
    static json<T>(body: T, init?: ResponseInit): NextResponse<T>;
    static redirect(url: string | URL, init?: number | ResponseInit): NextResponse;
    static rewrite(destination: string | URL, init?: ResponseInit): NextResponse;
    static next(init?: ResponseInit): NextResponse;
  }
  export function userAgent(req: { headers: Headers }): any;
  export function userAgentFromString(ua: string | undefined): any;
  export function after<T>(task: Promise<T> | (() => T | Promise<T>)): void;
  export function connection(): Promise<void>;
  export const URLPattern: typeof globalThis.URLPattern;
  export type NextMiddleware = (request: NextRequest, event: any) => any;
}

declare module "next/font/google" {
  type FontOptions = {
    weight?: string | string[];
    style?: string | string[];
    subsets?: string[];
    display?: string;
    preload?: boolean;
    fallback?: string[];
    adjustFontFallback?: boolean | string;
    variable?: string;
    axes?: string[];
  };

  type FontResult = {
    className: string;
    style: { fontFamily: string; fontWeight?: number; fontStyle?: string };
    variable?: string;
  };

  type FontLoader = (options?: FontOptions) => FontResult;
  // Named exports are generated in next-shims-font-google.generated.d.ts
  const googleFonts: Record<string, FontLoader>;
  export default googleFonts;
}

declare module "next/font/local" {
  type LocalFontSrc = {
    path: string;
    weight?: string;
    style?: string;
  };

  type LocalFontOptions = {
    src: string | LocalFontSrc | LocalFontSrc[];
    display?: string;
    weight?: string;
    style?: string;
    fallback?: string[];
    preload?: boolean;
    variable?: string;
    adjustFontFallback?: boolean | string;
    declarations?: Array<{ prop: string; value: string }>;
  };

  type FontResult = {
    className: string;
    style: { fontFamily: string; fontWeight?: number; fontStyle?: string };
    variable?: string;
  };

  export default function localFont(options: LocalFontOptions): FontResult;
}

declare module "next/app" {
  import * as React from "react";
  import type { ComponentType } from "react";

  export type AppProps<P = any> = {
    Component: ComponentType<P> & {
      getInitialProps?: (ctx: any) => any;
    };
    pageProps: P;
    router?: any;
    __N_SSG?: boolean;
    __N_SSP?: boolean;
  };

  export type AppContext = {
    Component: ComponentType<any> & {
      getInitialProps?: (ctx: any) => any;
    };
    AppTree: ComponentType<any>;
    ctx: any;
    router: any;
  };

  export type AppInitialProps<PageProps = any> = {
    pageProps: PageProps;
  };

  /**
   * Default `App` class component used by Pages Router `_app.js`. Mirrors
   * Next.js's `packages/next/src/pages/_app.tsx` so userland code can
   * `import App from "next/app"` and either subclass or call
   * `App.getInitialProps(appContext)` directly.
   */
  export default class App<P = any, CP = any, S = any> extends React.Component<
    P & AppProps<CP>,
    S
  > {
    static origGetInitialProps: (ctx: AppContext) => Promise<AppInitialProps>;
    static getInitialProps: (ctx: AppContext) => Promise<AppInitialProps>;
    render(): React.ReactNode;
  }
}

declare module "next/cache" {
  export type CacheHandler = {
    get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null>;
    set(
      key: string,
      data: IncrementalCacheValue | null,
      ctx?: Record<string, unknown>,
    ): Promise<void>;
    revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
    resetRequestCache?(): void;
  };

  export type CacheHandlerValue = {
    lastModified: number;
    age?: number;
    cacheState?: string;
    value: IncrementalCacheValue | null;
  };

  export type IncrementalCacheValue =
    | {
        kind: "FETCH";
        data: { headers: Record<string, string>; body: string; url: string; status?: number };
        tags?: string[];
        revalidate: number | false;
      }
    | {
        kind: "APP_PAGE";
        html: string;
        rscData: ArrayBuffer | undefined;
        headers: Record<string, string | string[]> | undefined;
        postponed: string | undefined;
        renderObservation?: unknown;
        status: number | undefined;
      }
    | {
        kind: "PAGES";
        html: string;
        pageData: object;
        headers: Record<string, string | string[]> | undefined;
        status: number | undefined;
      }
    | {
        kind: "APP_ROUTE";
        body: ArrayBuffer;
        status: number;
        headers: Record<string, string | string[]>;
      }
    | { kind: "REDIRECT"; props: object }
    | { kind: "IMAGE"; etag: string; buffer: ArrayBuffer; extension: string; revalidate?: number };

  /**
   * @deprecated Consumers should not instantiate cache handlers directly.
   * Configure caching via the `cache` option on the `vinext()` plugin; the
   * in-memory handler is the default when nothing is configured.
   */
  export class MemoryCacheHandler implements CacheHandler {
    constructor(options?: number | { cacheMaxMemorySize?: number; maxMemoryCacheSize?: number });
    get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null>;
    set(
      key: string,
      data: IncrementalCacheValue | null,
      ctx?: Record<string, unknown>,
    ): Promise<void>;
    revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
    resetRequestCache(): void;
  }

  /**
   * @deprecated Don't wire up the data cache imperatively. Configure it via the
   * `cache.data` option on the `vinext()` plugin (e.g. `kvDataAdapter()` from
   * `@vinext/cloudflare/cache/kv-data-adapter`) in your `vite.config.ts`.
   */
  export function setDataCacheHandler(handler: CacheHandler): void;
  export function getDataCacheHandler(): CacheHandler;
  /**
   * @deprecated Don't wire up the data cache imperatively. Configure it via the
   * `cache.data` option on the `vinext()` plugin (e.g. `kvDataAdapter()` from
   * `@vinext/cloudflare/cache/kv-data-adapter`) in your `vite.config.ts`.
   */
  export function setCacheHandler(handler: CacheHandler): void;
  /** @deprecated Use getDataCacheHandler. */
  export function getCacheHandler(): CacheHandler;
  export function configureMemoryCacheHandler(options?: {
    cacheMaxMemorySize?: number;
    maxMemoryCacheSize?: number;
  }): void;
  export function revalidateTag(tag: string, profile?: string | { expire?: number }): Promise<void>;
  export function revalidatePath(path: string, type?: "page" | "layout"): Promise<void>;
  export function updateTag(tag: string): Promise<void>;
  export function refresh(): void;
  export function unstable_cache<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    keyParts?: string[],
    options?: { revalidate?: number | false; tags?: string[] },
  ): T;
  export function unstable_noStore(): void;
  export function noStore(): void;
  export function io(): Promise<void>;
  /** @deprecated Use `io` instead. */
  export function unstable_io(): Promise<void>;

  // "use cache" APIs (Next.js 15+)
  export type CacheLifeConfig = {
    stale?: number;
    revalidate?: number;
    expire?: number;
  };
  export const cacheLifeProfiles: Record<string, CacheLifeConfig>;
  export function cacheLife(profile: string | CacheLifeConfig): void;
  export function cacheTag(...tags: string[]): void;
}

declare module "next/form" {
  import { ForwardRefExoticComponent, RefAttributes, FormHTMLAttributes } from "react";

  type FormProps = {
    action: string | ((formData: FormData) => void | Promise<void>);
    replace?: boolean;
    scroll?: boolean;
  } & Omit<FormHTMLAttributes<HTMLFormElement>, "action">;

  const Form: ForwardRefExoticComponent<FormProps & RefAttributes<HTMLFormElement>>;
  export default Form;
}

declare module "next/web-vitals" {
  import type { MetricType } from "web-vitals";

  export type WebVitalsMetric = MetricType;
  export type ReportWebVitalsCallback = (metric: WebVitalsMetric) => void;
  export function useReportWebVitals(callback: ReportWebVitalsCallback): void;
}

declare module "next/amp" {
  export function useAmp(): boolean;
  export function isInAmpMode(): boolean;
}

declare module "next/offline" {
  export function useOffline(): boolean;
}

declare module "next/og" {
  import { ReactElement } from "react";

  type ImageResponseOptions = {
    width?: number;
    height?: number;
    emoji?: "twemoji" | "blobmoji" | "noto" | "openmoji";
    fonts?: Array<{
      name: string;
      data: ArrayBuffer;
      weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
      style?: "normal" | "italic";
    }>;
    debug?: boolean;
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
  };

  export class ImageResponse extends Response {
    constructor(element: ReactElement, options?: ImageResponseOptions);
  }
}
