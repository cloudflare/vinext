import Link from "next/link";
import { RefreshButton } from "./refresh-button";

export const dynamic = "force-dynamic";

// Each render prints a fresh id, so a navigation that keeps the id kept the
// layout without running it again.
export default function PartialLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <p data-testid="partial-layout-render">{crypto.randomUUID()}</p>
      <nav>
        <Link href="/partial-layout/a" prefetch={false}>
          Page A
        </Link>
        <Link href="/partial-layout/b" prefetch={false}>
          Page B
        </Link>
        <Link href="/partial-layout/items/1" prefetch={false}>
          Item 1
        </Link>
        <Link href="/partial-layout/items/2" prefetch={false}>
          Item 2
        </Link>
      </nav>
      <RefreshButton />
      {children}
    </div>
  );
}
