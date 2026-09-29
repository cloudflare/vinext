import Link from "next/link";
import { RefreshDuringNavigationControls } from "./controls";

export default function RefreshDuringNavigationLayout({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <nav>
        <Link href="/refresh-during-navigation/slow" prefetch={false} data-testid="link-slow">
          Slow
        </Link>
      </nav>
      <RefreshDuringNavigationControls />
      {children}
    </main>
  );
}
