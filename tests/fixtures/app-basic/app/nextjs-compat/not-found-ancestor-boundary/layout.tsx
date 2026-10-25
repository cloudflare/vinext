/**
 * Test fixture: layout of the segment that owns the not-found boundary.
 * A page two levels down calls notFound(); this segment's not-found.tsx
 * replaces everything rendered inside this layout's children.
 */
import Link from "next/link";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div id="not-found-ancestor-boundary-layout">
      <nav>
        <Link href="/nextjs-compat/not-found-ancestor-boundary/section/missing">Missing</Link>
        <Link href="/nextjs-compat/not-found-ancestor-boundary/section/present">Present</Link>
        <Link href="/nextjs-compat/not-found-ancestor-boundary/section/own">Own</Link>
      </nav>
      {children}
    </div>
  );
}
