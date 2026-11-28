import type { AppProps } from "next/app";
import { siteName } from "../lib/kit";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div data-site={siteName()}>
      <Component {...pageProps} />
    </div>
  );
}
