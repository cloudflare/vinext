import { Suspense } from "react";
import { LayoutSentinel } from "./getSentinelValue";

export default function DynamicDataLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <p>
        This fixture asserts that dynamic request APIs behave correctly in top-level, force-dynamic,
        force-static, and client-page configurations.
      </p>
      <main>
        <LayoutSentinel />
        <Suspense fallback={<div id="boundary">loading...</div>}>{children}</Suspense>
      </main>
    </div>
  );
}
