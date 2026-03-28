declare module "next/link" {
  import type { ComponentType, AnchorHTMLAttributes, ReactNode } from "react";
  type UrlQueryValue = string | number | boolean | null | undefined;
  type UrlQuery = Record<string, UrlQueryValue | readonly UrlQueryValue[]>;
  interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
    href: string | { pathname?: string; query?: UrlQuery };
    as?: string;
    replace?: boolean;
    prefetch?: boolean;
    scroll?: boolean;
    onNavigate?: (event: { preventDefault(): void }) => void;
    children?: ReactNode;
  }
  const Link: ComponentType<LinkProps>;
  export default Link;
}
