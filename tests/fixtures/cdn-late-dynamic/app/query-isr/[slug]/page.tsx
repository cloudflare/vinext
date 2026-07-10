import { Suspense } from "react";
import QueryEcho from "./client";

export const revalidate = 60;

export default function QueryIsrPage() {
  return (
    <main>
      <h1>Query-aware ISR page</h1>
      <Suspense fallback={<p id="query-loading">loading</p>}>
        <QueryEcho />
      </Suspense>
    </main>
  );
}
