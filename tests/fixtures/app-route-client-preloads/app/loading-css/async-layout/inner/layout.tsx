import type { ReactNode } from "react";
import { LayoutNote } from "./layout-note";

export const dynamic = "force-dynamic";

// Issue #4735: the page renders below a layout that is still pending when
// loading.tsx's fallback flushes with the shell.
export default async function AsyncLayout({ children }: { children: ReactNode }) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return (
    <section>
      <LayoutNote />
      {children}
    </section>
  );
}
