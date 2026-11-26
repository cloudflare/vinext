import type { AppProps } from "next/app";
import localFont from "next/font/local";

// Copied to pages/_app.tsx by the test after the first request: an `_app`
// added while the dev server runs.
const font = localFont({ src: "../fonts/font-late.woff2" });

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={font.className}>
      <Component {...pageProps} />
    </div>
  );
}
