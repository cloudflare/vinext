import Link from "next/link";
import { HmrSuspenseScrollRenderProbe } from "./render-probe";

// Used by Playwright: app-router/hmr-suspense-scroll.spec.ts edits the marker
// and suspend to push RSC updates.
const MARKER = "before edit";

// No Suspense boundary of its own, so the layout's boundary is the nearest one.
async function SlowRows() {
  await new Promise((resolve) => setTimeout(resolve, 300));

  return Array.from({ length: 300 }, (_, index) => (
    <p key={index} style={{ height: 40, margin: 0 }}>
      Row {index}
    </p>
  ));
}

export default function HmrSuspenseScrollPage() {
  return (
    <main>
      <Link href="/hmr-suspense-scroll/target" data-testid="hmr-suspense-scroll-link">
        Target
      </Link>
      <HmrSuspenseScrollRenderProbe marker={MARKER} suspend={false} />
      <SlowRows />
    </main>
  );
}
