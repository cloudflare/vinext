/**
 * Test fixture: (.)photo intercepts photo/[id] in place of this segment's
 * page on a client navigation. The intercepting page is synchronous and
 * suspends with use(), with no loading.tsx. Like Next.js, the intercepting
 * layout renders while it suspends, with its own Suspense fallback.
 */
import Link from "next/link";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div id="sibling-intercept-layout-suspense-layout">
      <Link href="/nextjs-compat/sibling-intercept-layout-suspense/photo/1">Photo 1</Link>
      {children}
    </div>
  );
}
