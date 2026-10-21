import Link from "next/link";
import type { ReactNode } from "react";
import { sleep } from "../sleep";

// The spec prefetches loading shells itself, so it controls which URL each
// optimistic template is learned from.
const hrefs = ["2", "2?q=1", "3", "3?q=1"].map(
  (path) => `/loading-shell-remount/slow-layout-dynamic/${path}`,
);

export default async function SlowLayout({ children }: { children: ReactNode }) {
  await sleep(800);
  return (
    <div>
      <nav>
        {hrefs.map((href) => (
          <Link key={href} href={href} prefetch={false}>
            {href}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
