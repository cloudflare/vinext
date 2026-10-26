import Link from "next/link";
import type { ReactNode } from "react";

// Viewport-prefetched links that stay mounted across navigations between the
// pages below, which sit far enough down to scroll the links out of view.
export default function PrefetchQueuePersistentLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <ul>
        {Array.from({ length: 8 }, (_, index) => (
          <li key={index}>
            <Link className="persistent-link" href={`/prefetch-queue-viewport/${index + 1}`}>
              Target {index + 1}
            </Link>
          </li>
        ))}
      </ul>
      <div style={{ height: "6000px" }} />
      {children}
    </div>
  );
}
