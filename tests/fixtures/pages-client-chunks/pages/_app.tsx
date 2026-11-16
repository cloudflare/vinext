import type { AppProps } from "next/app";
import { AppFrame } from "../lib/app-frame";
import { BRAND } from "../lib/brand";
import { HomeLink } from "../lib/home-link";
import { kitTitle } from "../lib/kit";
import { telemetry } from "../lib/telemetry";

export const APP_TAGLINE = "Every desk, one atlas";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <AppFrame>
      <header data-events={telemetry.length}>
        {kitTitle(BRAND)} <HomeLink />
      </header>
      <Component {...pageProps} />
    </AppFrame>
  );
}
