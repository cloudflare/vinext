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
