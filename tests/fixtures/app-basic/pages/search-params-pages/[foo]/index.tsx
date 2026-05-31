import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

export default function Page() {
  const params = useParams();
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [paramsChangeCount, setParamsChangeCount] = useState(0);

  useEffect(() => {
    setParamsChangeCount((value) => value + 1);
  }, [params]);

  return (
    <div>
      <button id="rerender-button" onClick={() => setCount((value) => value + 1)}>
        Re-Render {count}
      </button>
      <button id="change-params-button" onClick={() => router.push("/search-params-pages/bar")}>
        Change Params
      </button>
      <output id="params">{JSON.stringify(params)}</output>
      <output id="params-change-count">{paramsChangeCount}</output>
    </div>
  );
}
