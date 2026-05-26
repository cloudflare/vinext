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
      </nav>
      {children}
    </>
  );
}
