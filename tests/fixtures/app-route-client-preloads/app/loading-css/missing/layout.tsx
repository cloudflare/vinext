import type { ReactNode } from "react";
import { MissingLayoutNote } from "./missing-layout-note";

// Below the root not-found boundary that catches the page's notFound(), so
// it doesn't render around the fallback.
export default function MissingLayout({ children }: { children: ReactNode }) {
  return (
    <section>
      <MissingLayoutNote />
      {children}
    </section>
  );
}
