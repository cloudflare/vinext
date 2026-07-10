import { useLayoutEffect } from "react";
import { useRouter } from "next/router";

export default function HydrationPage() {
  const router = useRouter();
  useLayoutEffect(() => {
    const target = window as typeof window & {
      __INITIAL_ROUTER_AS_PATH__?: string;
      __INITIAL_ROUTER_QUERY__?: string;
    };
    target.__INITIAL_ROUTER_QUERY__ = JSON.stringify(router.query);
    target.__INITIAL_ROUTER_AS_PATH__ = router.asPath;
  }, []);
  return (
    <main>
      <p id="query">{JSON.stringify(router.query)}</p>
      <p id="as-path">{router.asPath}</p>
      <p id="ready">{String(router.isReady)}</p>
    </main>
  );
}

export function getStaticProps() {
  return { props: {}, revalidate: 1 };
}
