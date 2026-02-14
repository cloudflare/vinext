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

declare module "next/server" {
  export class NextRequest extends Request {
    get nextUrl(): any;
    get cookies(): any;
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

  export const Inter: FontLoader;
  export const Roboto: FontLoader;
  export const Roboto_Mono: FontLoader;
  export const Open_Sans: FontLoader;
  export const Lato: FontLoader;
  export const Poppins: FontLoader;
  export const Montserrat: FontLoader;
  export const Source_Code_Pro: FontLoader;
  export const Noto_Sans: FontLoader;
  export const Raleway: FontLoader;
  export const Ubuntu: FontLoader;
  export const Nunito: FontLoader;
  export const Playfair_Display: FontLoader;
  export const Merriweather: FontLoader;
  export const PT_Sans: FontLoader;
  export const Fira_Code: FontLoader;
  export const JetBrains_Mono: FontLoader;
  export const Geist: FontLoader;
  export const Geist_Mono: FontLoader;
  // Any other Google Font can be imported via the Proxy
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
  export function revalidateTag(tag: string): Promise<void>;
  export function revalidatePath(path: string, type?: "page" | "layout"): Promise<void>;
  export function unstable_cache<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    keyParts?: string[],
    options?: { revalidate?: number | false; tags?: string[] },
  ): T;
}
