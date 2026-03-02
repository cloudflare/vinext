/**
 * Type declarations for next/* bare specifiers used within shims.
 *
 * These resolve via Vite's resolve.alias at runtime. This file
 * satisfies TypeScript when one shim imports another (e.g. link -> router).
 */

declare module "next/router" {
  export function useRouter(): any;
  export function setSSRContext(ctx: any): void;
  const Router: {
    push(url: string | object): Promise<boolean>;
    replace(url: string | object): Promise<boolean>;
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

declare module "next/dynamic" {
  import { ComponentType } from "react";
  function dynamic<P extends object = object>(
    loader: () => Promise<{ default: ComponentType<P> } | ComponentType<P>>,
    options?: { loading?: ComponentType<any>; ssr?: boolean },
  ): ComponentType<P>;
  export default dynamic;
  export function flushPreloads(): Promise<void[]>;
}

declare module "next/config" {
  interface RuntimeConfig {
    serverRuntimeConfig: Record<string, unknown>;
    publicRuntimeConfig: Record<string, unknown>;
  }
  export default function getConfig(): RuntimeConfig;
  export function setConfig(configValue: RuntimeConfig): void;
}

declare module "next/script" {
  import { ReactElement } from "react";
  interface ScriptProps {
    src?: string;
    strategy?: "beforeInteractive" | "afterInteractive" | "lazyOnload" | "worker";
    id?: string;
    onLoad?: (e: Event) => void;
    onReady?: () => void;
    onError?: (e: Event) => void;
    children?: React.ReactNode;
    dangerouslySetInnerHTML?: { __html: string };
    [key: string]: unknown;
  }
  const Script: (props: ScriptProps) => ReactElement | null;
  export default Script;
  export { ScriptProps };
  export function handleClientScriptLoad(props: ScriptProps): void;
  export function initScriptLoader(scripts: ScriptProps[]): void;
}

declare module "next/navigation" {
  export function useRouter(): {
    push(href: string, options?: { scroll?: boolean }): void;
    replace(href: string, options?: { scroll?: boolean }): void;
    back(): void;
    forward(): void;
    refresh(): void;
    prefetch(href: string): void;
  };
  export function usePathname(): string;
  export function useSearchParams(): URLSearchParams;
  export function useParams<T extends Record<string, string | string[]> = Record<string, string | string[]>>(): T;
  export function useSelectedLayoutSegment(parallelRoutesKey?: string): string | null;
  export function useSelectedLayoutSegments(parallelRoutesKey?: string): string[];
  export function useServerInsertedHTML(callback: () => unknown): void;
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
  export type ReadonlyURLSearchParams = URLSearchParams;

  // Context management (internal)
  export function setNavigationContext(ctx: any): void;
  export function setClientParams(params: Record<string, string | string[]>): void;
  export function getClientParams(): Record<string, string | string[]>;
  export function getLayoutSegmentContext(): import("react").Context<number> | null;

  // RSC prefetch cache utilities (shared between link.tsx and browser entry)
  export interface PrefetchCacheEntry {
    response: Response;
    timestamp: number;
  }
  export const PREFETCH_CACHE_TTL: number;
  export function toRscUrl(href: string): string;
  export function getPrefetchCache(): Map<string, PrefetchCacheEntry>;
  export function getPrefetchedUrls(): Set<string>;
  export function storePrefetchResponse(rscUrl: string, response: Response): void;
}

declare module "next/image" {
  import { ForwardRefExoticComponent, RefAttributes, ImgHTMLAttributes, CSSProperties, ReactEventHandler, MouseEventHandler } from "react";

  export interface StaticImageData {
    src: string;
    height: number;
    width: number;
    blurDataURL?: string;
  }

  interface ImageProps {
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
    onError?: ReactEventHandler<HTMLImageElement>;
    onClick?: MouseEventHandler<HTMLImageElement>;
    id?: string;
    unoptimized?: boolean;
    overrideSrc?: string;
    loading?: "lazy" | "eager";
  }

  const Image: ForwardRefExoticComponent<ImageProps & RefAttributes<HTMLImageElement>>;
  export default Image;

  export function getImageProps(props: ImageProps): {
    props: ImgHTMLAttributes<HTMLImageElement>;
  };
}

declare module "next/legacy/image" {
  import { ForwardRefExoticComponent, RefAttributes, CSSProperties, ReactEventHandler } from "react";

  interface LegacyImageProps {
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
  }

  const LegacyImage: ForwardRefExoticComponent<LegacyImageProps & RefAttributes<HTMLImageElement>>;
  export default LegacyImage;
}

declare module "next/error" {
  import { ComponentType } from "react";

  interface ErrorProps {
    statusCode: number;
    title?: string;
    withDarkMode?: boolean;
  }

  const ErrorComponent: ComponentType<ErrorProps>;
  export default ErrorComponent;
}

declare module "next/constants" {
  export const PHASE_PRODUCTION_BUILD: string;
  export const PHASE_DEVELOPMENT_SERVER: string;
  export const PHASE_PRODUCTION_SERVER: string;
  export const PHASE_EXPORT: string;
  export const PHASE_INFO: string;
  export const PHASE_TEST: string;
}

declare module "next/server" {
  export class NextRequest extends Request {
    get nextUrl(): any;
    get cookies(): any;
    get ip(): string | undefined;
    get geo(): { city?: string; country?: string; region?: string; latitude?: string; longitude?: string } | undefined;
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
  interface FontOptions {
    weight?: string | string[];
    style?: string | string[];
    subsets?: string[];
    display?: string;
    preload?: boolean;
    fallback?: string[];
    adjustFontFallback?: boolean | string;
    variable?: string;
    axes?: string[];
  }

  interface FontResult {
    className: string;
    style: { fontFamily: string };
    variable?: string;
  }

  type FontLoader = (options?: FontOptions) => FontResult;
  // Named exports are generated in next-shims-font-google.generated.d.ts
  const googleFonts: Record<string, FontLoader>;
  export default googleFonts;
}

declare module "next/font/local" {
  interface LocalFontSrc {
    path: string;
    weight?: string;
    style?: string;
  }

  interface LocalFontOptions {
    src: string | LocalFontSrc | LocalFontSrc[];
    display?: string;
    weight?: string;
    style?: string;
    fallback?: string[];
    preload?: boolean;
    variable?: string;
    adjustFontFallback?: boolean | string;
    declarations?: Array<{ prop: string; value: string }>;
  }

  interface FontResult {
    className: string;
    style: { fontFamily: string };
    variable?: string;
  }

  export default function localFont(options: LocalFontOptions): FontResult;
}

declare module "next/cache" {
  export interface CacheHandler {
    get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null>;
    set(key: string, data: IncrementalCacheValue | null, ctx?: Record<string, unknown>): Promise<void>;
    revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
    resetRequestCache?(): void;
  }

  export interface CacheHandlerValue {
    lastModified: number;
    age?: number;
    cacheState?: string;
    value: IncrementalCacheValue | null;
  }

  export type IncrementalCacheValue =
    | { kind: "FETCH"; data: { headers: Record<string, string>; body: string; url: string; status?: number }; tags?: string[]; revalidate: number }
    | { kind: "APP_PAGE"; html: string; rscData: ArrayBuffer | undefined; headers: Record<string, string | string[]> | undefined; postponed: string | undefined; status: number | undefined }
    | { kind: "PAGES"; html: string; pageData: object; headers: Record<string, string | string[]> | undefined; status: number | undefined }
    | { kind: "APP_ROUTE"; body: ArrayBuffer; status: number; headers: Record<string, string | string[]> }
    | { kind: "REDIRECT"; props: object }
    | { kind: "IMAGE"; etag: string; buffer: ArrayBuffer; extension: string; revalidate?: number };

  export class MemoryCacheHandler implements CacheHandler {
    get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null>;
    set(key: string, data: IncrementalCacheValue | null, ctx?: Record<string, unknown>): Promise<void>;
    revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
    resetRequestCache(): void;
  }

  export function setCacheHandler(handler: CacheHandler): void;
  export function getCacheHandler(): CacheHandler;
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

  // "use cache" APIs (Next.js 15+)
  export interface CacheLifeConfig {
    stale?: number;
    revalidate?: number;
    expire?: number;
  }
  export const cacheLifeProfiles: Record<string, CacheLifeConfig>;
  export function cacheLife(profile: string | CacheLifeConfig): void;
  export function cacheTag(...tags: string[]): void;
}

declare module "next/form" {
  import { ForwardRefExoticComponent, RefAttributes, FormHTMLAttributes } from "react";

  interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, "action"> {
    action: string | ((formData: FormData) => void | Promise<void>);
    replace?: boolean;
    scroll?: boolean;
  }

  const Form: ForwardRefExoticComponent<FormProps & RefAttributes<HTMLFormElement>>;
  export default Form;
}

declare module "next/web-vitals" {
  interface WebVitalsMetric {
    id: string;
    name: string;
    value: number;
    rating?: "good" | "needs-improvement" | "poor";
    delta: number;
    navigationType?: "navigate" | "reload" | "back-forward" | "prerender";
  }
  type ReportWebVitalsCallback = (metric: WebVitalsMetric) => void;
  export function useReportWebVitals(callback: ReportWebVitalsCallback): void;
}

declare module "next/amp" {
  export function useAmp(): boolean;
  export function isInAmpMode(): boolean;
}

declare module "next/og" {
  import { ReactElement } from "react";

  interface ImageResponseOptions {
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
  }

  export class ImageResponse extends Response {
    constructor(element: ReactElement, options?: ImageResponseOptions);
  }
}
