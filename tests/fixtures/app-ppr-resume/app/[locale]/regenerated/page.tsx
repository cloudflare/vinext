import { Suspense } from "react";
import { cacheTag } from "next/cache";
import { Greeting } from "../greeting";

async function getPageStamp() {
  "use cache";
  cacheTag("regenerated");
  return new Date().toISOString();
}

// A shell whose cached stamp /api/revalidate invalidates, so it regenerates.
export default async function RegeneratedPage() {
  return (
    <main>
      <p id="page-stamp">{await getPageStamp()}</p>
      <Suspense fallback={<p id="greeting-loading">Loading greeting…</p>}>
        <Greeting delayMs={0} />
      </Suspense>
    </main>
  );
}
