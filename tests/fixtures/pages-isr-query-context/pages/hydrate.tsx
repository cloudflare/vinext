import { useEffect, useLayoutEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "next/router";

export default function HydrationPage() {
  const router = useRouter();
  const params = useParams();
  const [mounted, setMounted] = useState(false);
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
  useEffect(() => setMounted(true), []);
  return (
    <main>
      <p id="query">{JSON.stringify(router.query)}</p>
      <p id="as-path">{mounted ? router.asPath : "/hydrate"}</p>
      <p id="ready">{mounted ? String(router.isReady) : "false"}</p>
      <p id="navigation-params">{mounted ? JSON.stringify(params) : "{}"}</p>
    </main>
  );
}

export function getStaticProps() {
  return { props: {}, revalidate: 1 };
}
