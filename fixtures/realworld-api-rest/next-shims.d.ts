/**
 * Type declarations for next/* module shims.
 *
 * These are resolved at runtime via Vite's resolve.alias to our
 * shim implementations. This file tells TypeScript they exist.
 */

declare module "next/head" {
  import { ComponentType, ReactNode } from "react";
  const Head: ComponentType<{ children?: ReactNode }>;
  export default Head;
  export function resetSSRHead(): void;
  export function getSSRHeadHTML(): string;
}

declare module "next/link" {
  import { ComponentType, AnchorHTMLAttributes, ReactNode } from "react";
  interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
    href: string | { pathname?: string; query?: Record<string, string> };
    as?: string;
    replace?: boolean;
    prefetch?: boolean;
    passHref?: boolean;
    scroll?: boolean;
    locale?: string | false;
    children?: ReactNode;
  }
  const Link: ComponentType<LinkProps>;
  export default Link;
}

declare module "next/router" {
  export function useRouter(): {
    pathname: string;
    route: string;
    query: Record<string, string | string[]>;
    asPath: string;
    basePath: string;
    isReady: boolean;
    isPreview: boolean;
    isFallback: boolean;
    push(url: string | object, as?: string, options?: object): Promise<boolean>;
    replace(url: string | object, as?: string, options?: object): Promise<boolean>;
    back(): void;
    reload(): void;
    prefetch(url: string): Promise<void>;
    events: {
      on(event: string, handler: (...args: unknown[]) => void): void;
      off(event: string, handler: (...args: unknown[]) => void): void;
      emit(event: string, ...args: unknown[]): void;
    };
  };
  export function setSSRContext(ctx: object | null): void;
  const Router: {
    push(url: string | object): Promise<boolean>;
    replace(url: string | object): Promise<boolean>;
    back(): void;
    reload(): void;
    prefetch(url: string): Promise<void>;
    events: {
      on(event: string, handler: (...args: unknown[]) => void): void;
      off(event: string, handler: (...args: unknown[]) => void): void;
      emit(event: string, ...args: unknown[]): void;
    };
  };
  export default Router;
}

declare module "next/image" {
  import { ComponentType } from "react";
  interface ImageProps {
    src: string | { src: string; height: number; width: number; blurDataURL?: string };
    alt: string;
    width?: number;
    height?: number;
    fill?: boolean;
    priority?: boolean;
    quality?: number;
    placeholder?: "blur" | "empty";
    blurDataURL?: string;
    sizes?: string;
    className?: string;
    style?: React.CSSProperties;
    loading?: "lazy" | "eager";
    [key: string]: unknown;
  }
  const Image: ComponentType<ImageProps>;
  export default Image;
}

declare module "next/dynamic" {
  import { ComponentType } from "react";
  interface DynamicOptions {
    loading?: ComponentType<{ error?: Error | null; isLoading?: boolean; pastDelay?: boolean }>;
    ssr?: boolean;
  }
  function dynamic<P extends object = object>(
    loader: () => Promise<{ default: ComponentType<P> } | ComponentType<P>>,
    options?: DynamicOptions,
  ): ComponentType<P>;
  export default dynamic;
  export function flushPreloads(): Promise<void[]>;
}

declare module "next/app" {
  import { ComponentType } from "react";
  export interface AppProps {
    Component: ComponentType<any>;
    pageProps: Record<string, unknown>;
  }
}

declare module "next" {
  import type { IncomingMessage, ServerResponse } from "node:http";
  export interface NextApiRequest extends IncomingMessage {
    query: Record<string, string | string[]>;
    body: unknown;
    cookies: Record<string, string>;
  }
  export interface NextApiResponse<T = unknown> extends ServerResponse {
    status(code: number): NextApiResponse<T>;
    json(data: T): void;
    send(data: T): void;
    redirect(statusOrUrl: number | string, url?: string): void;
  }
}

declare module "next/document" {
  import { ComponentType, ReactNode } from "react";
  export const Html: ComponentType<{ lang?: string; children?: ReactNode; [key: string]: unknown }>;
  export const Head: ComponentType<{ children?: ReactNode }>;
  export const Main: ComponentType;
  export const NextScript: ComponentType;
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
