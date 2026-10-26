import Link from "next/link";

export const metadata = { title: "Slot only layout" };

/**
 * Test fixture: a layout that renders only its @bar slot, whose intercepting
 * pages `(.)photo` and `(.)signal/[kind]` have no page before them on
 * Next.js's head walk: `children` renders nothing here. So a soft navigation
 * into an intercept takes the intercepting page's title, and its
 * generateMetadata() signals still reach its own boundaries inside the slot.
 */
export default function Layout({ bar }: { bar: React.ReactNode }) {
  return (
    <div id="slot-only-layout">
      <Link href="/nextjs-compat/slot-only-intercept/photo">Photo</Link>
      <Link href="/nextjs-compat/slot-only-intercept/signal/missing">Signal missing</Link>
      <Link href="/nextjs-compat/slot-only-intercept/signal/forbidden">Signal forbidden</Link>
      <Link href="/nextjs-compat/slot-only-intercept/signal/unauthorized">Signal unauthorized</Link>
      <div id="slot-only-bar">{bar}</div>
    </div>
  );
}
