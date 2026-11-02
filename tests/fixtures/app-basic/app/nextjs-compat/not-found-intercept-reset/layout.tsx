/**
 * Test fixture: layout of the segment that owns the not-found boundary. An
 * intercepted modal below it calls notFound(); this segment's not-found.tsx
 * replaces the feed layout and the modal, and must clear when the modal
 * navigates on to another photo.
 */
import Link from "next/link";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div id="not-found-intercept-reset-layout">
      <nav>
        <Link href="/nextjs-compat/not-found-intercept-reset/feed/photo/missing">
          Missing photo
        </Link>
        <Link href="/nextjs-compat/not-found-intercept-reset/feed/photo/1">Photo 1</Link>
      </nav>
      {children}
    </div>
  );
}
