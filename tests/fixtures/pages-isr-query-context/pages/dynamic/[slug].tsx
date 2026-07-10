import { useEffect, useLayoutEffect, useState } from "react";
import { useParams, usePathname } from "next/navigation";
import { useRouter } from "next/router";

export default function DynamicIsrPage() {
  const router = useRouter();
  const params = useParams();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    const target = window as typeof window & {
      __INITIAL_NAVIGATION_PATHNAME__?: string | null;
      __INITIAL_NAVIGATION_PARAMS__?: string;
      __INITIAL_ROUTER_AS_PATH__?: string;
      __INITIAL_ROUTER_QUERY__?: string;
      __INITIAL_ROUTER_READY__?: boolean;
    };
    target.__INITIAL_NAVIGATION_PATHNAME__ = pathname;
    target.__INITIAL_NAVIGATION_PARAMS__ = JSON.stringify(params);
    target.__INITIAL_ROUTER_QUERY__ = JSON.stringify(router.query);
    target.__INITIAL_ROUTER_AS_PATH__ = router.asPath;
    target.__INITIAL_ROUTER_READY__ = router.isReady;
  }, []);
  useEffect(() => setMounted(true), []);
  return (
    <main>
      <p id="query">{JSON.stringify(router.query)}</p>
      <p id="as-path">{mounted ? router.asPath : pathname}</p>
      <p id="ready">{mounted ? String(router.isReady) : "false"}</p>
      <p id="navigation-pathname">{pathname}</p>
      <p id="navigation-params">{mounted ? JSON.stringify(params) : "null"}</p>
      <button id="navigate-clean" onClick={() => router.push("/dynamic/clean?via=client")}>
        Navigate
      </button>
    </main>
  );
}

export function getStaticPaths() {
  return {
    paths: [{ params: { slug: "known" } }, { params: { slug: "clean" } }],
    fallback: "blocking",
  };
}

export function getStaticProps() {
  return { props: {}, revalidate: 1 };
}
