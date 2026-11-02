import { Suspense } from "react";
import { Slow } from "../slow";

export const dynamic = "force-dynamic";

// Rendering Slow here too keeps it out of /import-order's client reference
// group, so its stylesheet is a file of its own.
export default function SlowOnly() {
  return (
    <Suspense fallback={<p data-testid="import-order-fallback">loading</p>}>
      <Slow />
    </Suspense>
  );
}
