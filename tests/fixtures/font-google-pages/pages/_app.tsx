import type { AppProps } from "next/app";
import { Geist, Open_Sans, Roboto } from "next/font/google";
import localFont from "next/font/local";

const localSans = localFont({
  src: [
    {
      path: "./noto-sans-wdth-wght.ttf",
      style: "normal",
    },
  ],
  variable: "--font-local-sans",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  fallback: ["system-ui", "Arial"],
});

const openSans = Open_Sans({
  subsets: ["latin"],
  adjustFontFallback: false,
});

const roboto = Roboto({
  subsets: ["latin"],
  adjustFontFallback: false,
  fallback: ["system-ui", "Arial"],
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={`${geistSans.variable} ${localSans.variable} ${localSans.className}`}>
      <p className={geistSans.className}>Adjusted and manual fallback</p>
      <p className={openSans.className}>No adjusted fallback</p>
      <p className={roboto.className}>Manual fallback only</p>
      <Component {...pageProps} />
    </div>
  );
}
