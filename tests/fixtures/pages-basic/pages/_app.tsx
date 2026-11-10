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

// Next.js never calls data exports from _app; the client build strips them as
// it does a page's.
export async function getStaticProps() {
  return { props: { value: "SOURCEMAP_APP_STATIC_PROPS" } };
}
