import { Suspense } from "react";
import { DynamicPreloadChunks } from "../shims/dynamic-preload-chunks";

export const dynamic = "force-dynamic";

// A user component sharing the export name and the `shims/dynamic-preload-chunks`
// path of vinext's preload helper: the SSR entry must tell them apart, or this
// boundary's fallback waits for the module.
export default function CollisionPage() {
  return (
    <main>
      <h1>collision</h1>
      <Suspense fallback={<p data-testid="fallback">loading</p>}>
        <DynamicPreloadChunks />
      </Suspense>
    </main>
  );
}
