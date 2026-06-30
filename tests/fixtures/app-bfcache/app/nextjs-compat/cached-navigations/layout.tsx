import Link from "next/link";
import type { ReactNode } from "react";

export default function CachedNavigationsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav>
        <Link href="/nextjs-compat/cached-navigations" prefetch={false}>
          Home
        </Link>
      </nav>
      {children}
    </>
  );
}
