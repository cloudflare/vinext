import { Suspense } from "react";
import { StreamedPanel } from "../streamed-panel";

export const dynamic = "force-dynamic";

// A second route rendering the panel keeps it out of /streamed's client
// reference group, so its stylesheet is a file of its own.
export default function StreamedAlso() {
  return (
    <Suspense fallback={<p data-testid="streamed-fallback">loading</p>}>
      <StreamedPanel />
    </Suspense>
  );
}
