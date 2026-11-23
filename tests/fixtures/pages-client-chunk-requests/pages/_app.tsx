import type { AppProps } from "next/app";
import { SiteFooter } from "../lib/site-footer";
import { SiteFrame } from "../lib/site-frame";
import { SiteHeader } from "../lib/site-header";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <SiteFrame>
      <SiteHeader />
      <div data-marker="marker-app">
        <Component {...pageProps} />
      </div>
      <SiteFooter />
    </SiteFrame>
  );
}
