import type { AppProps } from "next/app";
import { Geist } from "next/font/google";
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
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={`${geistSans.variable} ${localSans.variable} ${localSans.className}`}>
      <Component {...pageProps} />
    </div>
  );
}
