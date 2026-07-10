import { Suspense } from "react";
import QueryEcho from "./client";

export const dynamic = "error";
export const revalidate = 60;

export default function QueryDynamicErrorPage() {
  return (
    <main>
      <Suspense fallback={<p data-testid="fallback">query fallback</p>}>
        <QueryEcho />
      </Suspense>
    </main>
  );
}
