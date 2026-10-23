import Link from "next/link";
import type { ReactNode } from "react";
import { sleep } from "../sleep";

// An async layout above loading.tsx, over a client page.
export default async function SlowLayout({ children }: { children: ReactNode }) {
  await sleep(800);
  return (
    <div>
      <nav>
        <Link href="/loading-shell-remount/client-page/a">A</Link>
        <Link href="/loading-shell-remount/client-page/b">B</Link>
      </nav>
      {children}
    </div>
  );
}
