import type { AppProps } from "next/app";
import { ErrorBoundary } from "../lib/error-boundary";
import { SiteFrame } from "../lib/site-frame";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <SiteFrame>
      <ErrorBoundary>
        <div data-marker="marker-app">
          <Component {...pageProps} />
        </div>
      </ErrorBoundary>
    </SiteFrame>
  );
}
