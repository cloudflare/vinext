import type { AppProps } from "next/app";
import { Nav } from "../components/nav";
import "../styles/global.css";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <h1 className="app-title" data-probe="title">
        CSS navigation
      </h1>
      <Nav />
      <Component {...pageProps} />
    </>
  );
}
