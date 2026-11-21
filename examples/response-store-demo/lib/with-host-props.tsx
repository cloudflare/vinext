import type { NextPage, NextPageContext } from "next";

// Attaches a getInitialProps the page's own source never names, so only the
// render can tell it runs.
export function withHostProps(Page: NextPage<{ host: string }>): NextPage<{ host: string }> {
  Page.getInitialProps = ({ req, res }: NextPageContext) => {
    res?.setHeader("CDN-Cache-Control", "public, s-maxage=60");
    return { host: req?.headers.host ?? "" };
  };
  return Page;
}
