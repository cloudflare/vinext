import type { AppProps } from "next/app";
import { Geist } from "next/font/google";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={geistSans.variable}>
      <Component {...pageProps} />
    </div>
  );
}
