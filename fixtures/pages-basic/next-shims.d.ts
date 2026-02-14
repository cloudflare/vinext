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
  export interface NextApiResponse extends ServerResponse {
    status(code: number): NextApiResponse;
    json(data: unknown): void;
    send(data: unknown): void;
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
