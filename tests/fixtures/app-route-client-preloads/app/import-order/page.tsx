import { Suspense } from "react";
import { Fast } from "./fast";
import { Slow } from "./slow";

export const dynamic = "force-dynamic";

// Imports the top-level-await component second, though it renders first.
export default function ImportOrder() {
  return (
    <main>
      <Suspense fallback={<p data-testid="import-order-fallback">loading</p>}>
        <Slow />
      </Suspense>
      <Fast />
    </main>
  );
}
