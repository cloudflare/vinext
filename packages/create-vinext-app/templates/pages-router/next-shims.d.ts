// Type declarations for vinext shim modules
declare module "next/head" {
  export default function Head(props: { children?: React.ReactNode }): React.ReactElement;
  export function resetSSRHead(): void;
  export function getSSRHeadHTML(): string;
}
declare module "next/link" {
  import type { AnchorHTMLAttributes } from "react";
  export type LinkProps = {
    href: string;
    as?: string;
    replace?: boolean;
    scroll?: boolean;
    shallow?: boolean;
    passHref?: boolean;
    prefetch?: boolean;
    locale?: string | false;
    legacyBehavior?: boolean;
  } & AnchorHTMLAttributes<HTMLAnchorElement>;
  export default function Link(props: LinkProps): React.ReactElement;
}
declare module "next/router" {
  export function useRouter(): {
    pathname: string;
    route: string;
    query: Record<string, string | string[]>;
    asPath: string;
    basePath: string;
    isReady: boolean;
    push(url: string | object, as?: string): Promise<boolean>;
    replace(url: string | object, as?: string): Promise<boolean>;
    back(): void;
    reload(): void;
    prefetch(url: string): Promise<void>;
  };
  export function setSSRContext(ctx: object | null): void;
}
