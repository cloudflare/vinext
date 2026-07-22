import type { ReactNode } from "react";
import Link from "next/link";
import { RouterAutoscrollControls } from "./router-controls";

export default function RouterAutoscrollLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <RouterAutoscrollControls />
      <nav
        style={{
          background: "white",
          left: 0,
          position: "fixed",
          top: 0,
          zIndex: 1,
        }}
      >
        <Link href="/nextjs-compat/router-autoscroll/non-focusable-target" id="to-non-focusable">
          Non-focusable target
        </Link>
        <Link
          href="/nextjs-compat/router-autoscroll/scrollable-segment"
          id="to-scrollable-segment"
          style={{ marginLeft: 12 }}
        >
          Scrollable segment
        </Link>
        <Link
          href="/nextjs-compat/router-autoscroll/segment-with-focusable-descendant"
          id="to-focusable-descendant"
          style={{ marginLeft: 12 }}
        >
          Focusable descendant
        </Link>
        <Link
          href="/nextjs-compat/router-autoscroll/uri-fragments#section-2"
          id="to-uri-fragment"
          style={{ marginLeft: 12 }}
        >
          URI fragment
        </Link>
      </nav>
      {children}
    </>
  );
}
