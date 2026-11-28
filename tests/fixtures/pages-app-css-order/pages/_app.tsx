import type { AppProps } from "next/app";
import "../styles/global.css";
import { Badge } from "../components/badge";

// The global stylesheet is `_app`'s first import, ahead of the badge.
export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <header>
        <Badge testId="app-badge" />
      </header>
      <Component {...pageProps} />
    </>
  );
}
