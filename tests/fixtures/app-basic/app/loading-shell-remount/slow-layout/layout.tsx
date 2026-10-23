import Link from "next/link";
import type { ReactNode } from "react";
import { sleep } from "../sleep";

// An async layout above the pages' loading.tsx, with no Suspense of its own.
export default async function SlowLayout({ children }: { children: ReactNode }) {
  await sleep(800);
  return (
    <div>
      <nav>
        <Link href="/loading-shell-remount/slow-layout/a">A</Link>
        <Link href="/loading-shell-remount/slow-layout/b">B</Link>
      </nav>
      {children}
    </div>
  );
}
