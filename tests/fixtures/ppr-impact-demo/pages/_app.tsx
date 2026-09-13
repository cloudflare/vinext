import type { AppProps } from "next/app";

export default function CacheabilityPagesApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}

// Next.js explicitly keeps getStaticProps pages static when a custom _app has
// getInitialProps:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/index.ts
CacheabilityPagesApp.getInitialProps = async () => ({ pageProps: {} });
