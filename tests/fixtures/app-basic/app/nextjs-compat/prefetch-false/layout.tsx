import Link from "next/link";
import type { ReactNode } from "react";

export default function PrefetchFalseLayout({ children }: { children: ReactNode }) {
  return (
    <section>
      <div>
        <Link prefetch={false} href="/nextjs-compat/prefetch-false/foo">
          foo
        </Link>
      </div>
      <div>
        <Link prefetch={false} href="/nextjs-compat/prefetch-false/foo/bar">
          foo/bar
        </Link>
      </div>
      {children}
    </section>
  );
}
