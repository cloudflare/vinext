import type { AppProps } from "next/app";
import "../styles/dev css adoption.css";
import "../styles/dev-css-adoption-override.css";

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
