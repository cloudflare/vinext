import Link from "next/link";
import type { ReactNode } from "react";

// The spec prefetches loading shells itself, so it controls which URL each
// optimistic template is learned from.
const hrefs = ["2", "3", "4"].map((id) => `/loading-shell-remount/dynamic-layout/${id}`);

export default function DynamicLayoutRoot({ children }: { children: ReactNode }) {
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
