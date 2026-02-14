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
