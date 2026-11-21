import { Suspense } from "react";

export default function InterceptLayout({ children }: { children: React.ReactNode }) {
  return (
    <aside id="sibling-intercept-layout-suspense-modal">
      <p>Modal chrome</p>
      <Suspense fallback={<p id="sibling-intercept-layout-suspense-spinner">Loading photo...</p>}>
        {children}
      </Suspense>
    </aside>
  );
}
