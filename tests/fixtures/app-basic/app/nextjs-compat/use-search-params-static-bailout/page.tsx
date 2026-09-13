import { Suspense } from "react";
import SearchParamsValue from "./search-params";

export default function Page() {
  return (
    <Suspense fallback={<p id="search-params-suspense">search params suspense</p>}>
      <SearchParamsValue />
    </Suspense>
  );
}
