import { useLayoutEffect } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "next/router";

export default function HydrationPage() {
  const router = useRouter();
  const params = useParams();
  useLayoutEffect(() => {
    const target = window as typeof window & {
      __INITIAL_ROUTER_AS_PATH__?: string;
      __INITIAL_ROUTER_QUERY__?: string;
      __INITIAL_ROUTER_READY__?: boolean;
    };
    target.__INITIAL_ROUTER_QUERY__ = JSON.stringify(router.query);
    target.__INITIAL_ROUTER_AS_PATH__ = router.asPath;
    target.__INITIAL_ROUTER_READY__ = router.isReady;
  }, []);
  return (
    <main>
      <p id="query">{JSON.stringify(router.query)}</p>
      <p id="as-path">{router.asPath}</p>
      <p id="ready">{String(router.isReady)}</p>
      <p id="navigation-params">{JSON.stringify(params)}</p>
    </main>
  );
}

export function getStaticProps() {
  return { props: {}, revalidate: 1 };
}
