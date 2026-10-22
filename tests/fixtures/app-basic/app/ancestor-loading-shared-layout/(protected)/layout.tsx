import Link from "next/link";
import { connection } from "next/server";

// Mirrors an auth layout that awaits a session check before rendering its tabs.
// Matches the structure reported in cloudflare/vinext#3725.
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 100));

  return (
    <section>
      <nav id="ancestor-shared-layout-tabs">
        <Link href="/ancestor-loading-shared-layout" id="ancestor-shared-layout-home-link">
          Overview
        </Link>
        <Link
          href="/ancestor-loading-shared-layout/settings"
          id="ancestor-shared-layout-settings-link"
        >
          Settings
        </Link>
        <Link href="/ancestor-loading-shared-layout/nested" id="ancestor-shared-layout-nested-link">
          Nested
        </Link>
      </nav>
      {children}
    </section>
  );
}
