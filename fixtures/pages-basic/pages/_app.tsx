import type { AppProps } from "next/app";

export default function MyApp({ Component, pageProps }: AppProps) {
  return (
    <div id="app-wrapper" data-testid="app-wrapper">
      <nav data-testid="global-nav">
        <span>My App</span>
      </nav>
      <Component {...pageProps} />
    </div>
  );
}
