import { useEffect, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRouter as usePagesRouter } from "next/router";

export default function Page() {
  const params = useParams();
  const router = useRouter();
  const pagesRouter = usePagesRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [count, setCount] = useState(0);
  const [paramsChangeCount, setParamsChangeCount] = useState(0);
  const [searchParamsChangeCount, setSearchParamsChangeCount] = useState(0);
  const [paramsSnapshots, setParamsSnapshots] = useState<string[]>([]);
  const [searchParamsSnapshots, setSearchParamsSnapshots] = useState<string[]>([]);
  const [currentSearchParams, setCurrentSearchParams] = useState("");
  const [pagesRouterReady, setPagesRouterReady] = useState("");

  useEffect(() => {
    const snapshot = JSON.stringify(params);
    console.log(`params changed ${snapshot}`);
    setParamsSnapshots((values) => [...values, snapshot]);
    setParamsChangeCount((value) => value + 1);
  }, [params]);

  useEffect(() => {
    const snapshot = searchParams.toString();
    console.log(`search params changed ${snapshot}`);
    setSearchParamsSnapshots((values) => [...values, snapshot]);
    setCurrentSearchParams(snapshot);
    setSearchParamsChangeCount((value) => value + 1);
  }, [searchParams]);

  useEffect(() => {
    setPagesRouterReady(String(pagesRouter.isReady));
  }, [pagesRouter.isReady]);

  return (
    <div>
      <button id="rerender-button" onClick={() => setCount((value) => value + 1)}>
        Re-Render {count}
      </button>
      <button id="change-params-button" onClick={() => router.push("/search-params-pages/bar")}>
        Change Params
      </button>
      <output id="params">{JSON.stringify(params)}</output>
      <output id="pathname-direct">{JSON.stringify(pathname)}</output>
      <output id="params-change-count">{paramsChangeCount}</output>
      <output id="params-snapshots">{JSON.stringify(paramsSnapshots)}</output>
      <output id="search-params-direct">{searchParams.toString()}</output>
      <output id="search-params">{currentSearchParams}</output>
      <output id="search-params-change-count">{searchParamsChangeCount}</output>
      <output id="search-params-snapshots">{JSON.stringify(searchParamsSnapshots)}</output>
      <output id="pages-router-ready">{pagesRouterReady}</output>
    </div>
  );
}
