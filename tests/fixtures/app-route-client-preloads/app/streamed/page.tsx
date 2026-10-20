import { Suspense } from "react";
import { StreamedPanel } from "./streamed-panel";
import { Badge } from "./badge";

export const dynamic = "force-dynamic";

export default function Streamed() {
  return (
    <main>
      <Suspense fallback={<p data-testid="streamed-fallback">loading</p>}>
        <StreamedPanel />
      </Suspense>
      <Badge />
    </main>
  );
}
