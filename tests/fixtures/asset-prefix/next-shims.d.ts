/**
 * Type declarations for next/* module shims.
 *
 * These are resolved at runtime via Vite's resolve.alias to our
 * shim implementations. This file tells TypeScript they exist.
 */

declare module "next/link" {
  import { ComponentType, AnchorHTMLAttributes, ReactNode } from "react";
  interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
    href: string;
    children?: ReactNode;
  }
  const Link: ComponentType<LinkProps>;
  export default Link;
}

declare module "next/app" {
  import { ComponentType } from "react";
  export interface AppProps {
    Component: ComponentType<any>;
    pageProps: Record<string, unknown>;
  }
}
