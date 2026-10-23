import Link from "next/link";
import type { ReactNode } from "react";
import { sleep } from "../sleep";

// An async layout above loading.tsx, over a dynamic client page. The spec
// prefetches loading shells itself, so it controls which URL each optimistic
// template is learned from.
export default async function SlowLayout({ children }: { children: ReactNode }) {
  await sleep(800);
  return (
    <div>
      <nav>
        <Link href="/loading-shell-remount/client-page-dynamic/2" prefetch={false}>
          2
        </Link>
        <Link href="/loading-shell-remount/client-page-dynamic/3" prefetch={false}>
          3
        </Link>
      </nav>
      {children}
    </div>
  );
}
