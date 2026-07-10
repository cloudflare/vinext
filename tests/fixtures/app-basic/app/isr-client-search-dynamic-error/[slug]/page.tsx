import { Suspense } from "react";
import DynamicErrorQueryEcho from "./client";

export const dynamic = "error";
export const revalidate = 1;

export default function DynamicErrorClientSearchParamsPage() {
  return (
    <main>
      <h1>Dynamic-error client search params</h1>
      <Suspense fallback={<p data-testid="dynamic-error-query-loading">loading</p>}>
        <DynamicErrorQueryEcho />
      </Suspense>
    </main>
  );
}
