import { useRouter } from "next/router";

declare global {
  interface Window {
    __INITIAL_FALLBACK_AS_PATH__?: string;
    __INITIAL_FALLBACK_QUERY__?: string;
    __INITIAL_FALLBACK_READY__?: boolean;
    __INITIAL_FALLBACK_RECORDED__?: boolean;
    __INITIAL_FALLBACK_SLUG__?: string;
  }
}

export default function FallbackPage() {
  const router = useRouter();

  if (typeof window !== "undefined" && !window.__INITIAL_FALLBACK_RECORDED__) {
    window.__INITIAL_FALLBACK_RECORDED__ = true;
    window.__INITIAL_FALLBACK_QUERY__ = JSON.stringify(router.query);
    window.__INITIAL_FALLBACK_SLUG__ = router.query.slug as string | undefined;
    window.__INITIAL_FALLBACK_AS_PATH__ = router.asPath;
    window.__INITIAL_FALLBACK_READY__ = router.isReady;
  }

  if (router.isFallback) {
    return (
      <main>
        <p id="fallback">Loading...</p>
        <p id="fallback-query">{JSON.stringify(router.query)}</p>
        {/* Next.js publishes the live browser asPath before isReady. This direct
            server/client probe intentionally observes both values. */}
        <p id="fallback-as-path" suppressHydrationWarning>
          {router.asPath}
        </p>
        <p id="fallback-ready">{String(router.isReady)}</p>
      </main>
    );
  }

  return (
    <main>
      <p id="query">{JSON.stringify(router.query)}</p>
      <p id="as-path">{router.asPath}</p>
      <p id="ready">{String(router.isReady)}</p>
    </main>
  );
}

export function getStaticPaths() {
  return { paths: [], fallback: true };
}

export function getStaticProps() {
  return { props: {}, revalidate: 1 };
}
