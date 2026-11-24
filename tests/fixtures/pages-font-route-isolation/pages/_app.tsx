import type { AppProps } from "next/app";
import localFont from "next/font/local";

const font = localFont({ src: "../fonts/font-app.woff2" });

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={font.className}>
      <Component {...pageProps} />
    </div>
  );
}
