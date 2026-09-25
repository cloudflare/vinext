import Link from "next/link";
import type { ReactNode } from "react";

// Streams the RSC response instead of holding it for a cache decision, so a
// navigation commits while the panel is still pending.
export const dynamic = "force-dynamic";

export default function KeptClientPageLayout({
  children,
  panel,
}: {
  children: ReactNode;
  panel: ReactNode;
}) {
  return (
    <main>
      <Link href="/client-page-search-params/kept/other" data-testid="kept-client-page-other-link">
        other
      </Link>
      {children}
      <aside>{panel}</aside>
    </main>
  );
}
