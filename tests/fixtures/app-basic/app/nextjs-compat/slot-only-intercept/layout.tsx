import Link from "next/link";

export const metadata = { title: "Slot only layout" };

/**
 * Test fixture: a layout that renders only its @bar slot, whose intercepting
 * page `(.)photo` has no page before it on Next.js's head walk: `children`
 * renders nothing here. So a soft navigation into the intercept takes the
 * intercepting page's title.
 */
export default function Layout({ bar }: { bar: React.ReactNode }) {
  return (
    <div id="slot-only-layout">
      <Link href="/nextjs-compat/slot-only-intercept/photo">Photo</Link>
      <div id="slot-only-bar">{bar}</div>
    </div>
  );
}
