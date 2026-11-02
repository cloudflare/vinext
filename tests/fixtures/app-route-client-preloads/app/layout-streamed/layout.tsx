import { Suspense, type ReactNode } from "react";
import { LayoutPanel } from "./layout-panel";

export default function StreamedLayout({ children }: { children: ReactNode }) {
  return (
    <section>
      <Suspense fallback={<p data-testid="layout-fallback">loading</p>}>
        <LayoutPanel />
      </Suspense>
      {children}
    </section>
  );
}
