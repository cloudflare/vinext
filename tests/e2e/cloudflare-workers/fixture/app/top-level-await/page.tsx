import { Suspense } from "react";
import { Panel } from "./panel";

export const dynamic = "force-dynamic";

export default function TopLevelAwaitPage() {
  return (
    <main>
      <Suspense fallback={<p data-testid="top-level-await-fallback">loading</p>}>
        <Panel />
      </Suspense>
    </main>
  );
}
