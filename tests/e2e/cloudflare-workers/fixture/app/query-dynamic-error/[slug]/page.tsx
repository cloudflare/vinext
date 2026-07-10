import { Suspense } from "react";
import QueryEcho from "./client";

export const dynamic = "error";
export const revalidate = 1;

export default function WorkerDynamicErrorPage() {
  return (
    <main>
      <Suspense fallback={<p data-testid="worker-query-fallback">worker query fallback</p>}>
        <QueryEcho />
      </Suspense>
    </main>
  );
}
