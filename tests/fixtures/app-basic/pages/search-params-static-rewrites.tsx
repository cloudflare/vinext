import { useEffect, useState } from "react";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useRouter as usePagesRouter } from "next/router";

export default function StaticPagesRouteWithRewrites() {
  const params = useParams();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const pagesRouter = usePagesRouter();
  const [paramsSnapshots, setParamsSnapshots] = useState<string[]>([]);
  const [searchParamsSnapshots, setSearchParamsSnapshots] = useState<string[]>([]);
  const [pagesRouterReady, setPagesRouterReady] = useState("");

  useEffect(() => {
    const snapshot = JSON.stringify(params);
    console.log(`static rewrites params changed ${snapshot}`);
    setParamsSnapshots((values) => [...values, snapshot]);
  }, [params]);

  useEffect(() => {
    const snapshot = searchParams.toString();
    console.log(`static rewrites search params changed ${snapshot}`);
    setSearchParamsSnapshots((values) => [...values, snapshot]);
  }, [searchParams]);

  useEffect(() => {
    setPagesRouterReady(String(pagesRouter.isReady));
  }, [pagesRouter.isReady]);

  return (
    <div>
      <output id="params-direct">{JSON.stringify(params)}</output>
      <output id="pathname-direct">{JSON.stringify(pathname)}</output>
      <output id="params-snapshots">{JSON.stringify(paramsSnapshots)}</output>
      <output id="search-params-direct">{searchParams.toString()}</output>
      <output id="search-params-snapshots">{JSON.stringify(searchParamsSnapshots)}</output>
      <output id="pages-router-ready">{pagesRouterReady}</output>
    </div>
  );
}
