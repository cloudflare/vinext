declare module "next/link" {
  import type { ComponentType, AnchorHTMLAttributes, ReactNode } from "react";
  interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
    href: string | { pathname?: string; query?: Record<string, string> };
    as?: string;
    replace?: boolean;
    prefetch?: boolean;
    scroll?: boolean;
    children?: ReactNode;
  }
  const Link: ComponentType<LinkProps>;
  export default Link;
}

declare module "next/navigation" {
  export function usePathname(): string;
  export function useSearchParams(): URLSearchParams;
  export function useParams<T = Record<string, string | string[]>>(): T;
  export function useRouter(): {
    push(href: string, options?: { scroll?: boolean }): void;
    replace(href: string, options?: { scroll?: boolean }): void;
    back(): void;
    forward(): void;
    refresh(): void;
    prefetch(href: string): void;
  };
  export function redirect(url: string, type?: "replace" | "push"): never;
  export function permanentRedirect(url: string): never;
  export function notFound(): never;
}

declare module "next/headers" {
  export function headers(): Promise<Headers>;
  export function cookies(): Promise<any>;
  export function draftMode(): Promise<{ isEnabled: boolean }>;
}
