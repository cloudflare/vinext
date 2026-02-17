// Type declarations for vinext shim modules
declare module "next/head" {
  export default function Head(props: { children?: React.ReactNode }): React.ReactElement;
  export function resetSSRHead(): void;
  export function getSSRHeadHTML(): string;
}
declare module "next/link" {
  import type { AnchorHTMLAttributes } from "react";
  export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
    href: string;
    as?: string;
    replace?: boolean;
    scroll?: boolean;
    shallow?: boolean;
    passHref?: boolean;
    prefetch?: boolean;
    locale?: string | false;
    legacyBehavior?: boolean;
  }
  export default function Link(props: LinkProps): React.ReactElement;
}
declare module "next/router" {
  export function useRouter(): any;
  export function setSSRContext(ctx: any): void;
}
