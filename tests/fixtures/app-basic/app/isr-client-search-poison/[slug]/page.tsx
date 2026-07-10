import { Suspense } from "react";
import QueryEcho from "./client";

export const revalidate = 1;

export default function ClientSearchParamsIsrPage() {
  return (
    <main>
      <h1>Client search params ISR</h1>
      <Suspense fallback={<p data-testid="query-loading">loading</p>}>
        <QueryEcho />
      </Suspense>
    </main>
  );
}
