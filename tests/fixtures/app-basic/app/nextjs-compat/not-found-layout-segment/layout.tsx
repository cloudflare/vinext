/**
 * Test fixture: layout above the [lang] segment, which has a not-found file
 * but no layout. Its client counter shows whether the layout stays mounted
 * while the [lang] boundary catches signals below it.
 */
import Link from "next/link";
import { SegmentCounter } from "./counter";

const BASE = "/nextjs-compat/not-found-layout-segment/en";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div id="not-found-layout-segment-layout">
      <SegmentCounter />
      <nav>
        <Link href={`${BASE}/shop/hello`}>Item</Link>
        <Link href={`${BASE}/shop/gone`}>Gone</Link>
        <Link href={`${BASE}/slow/invalid`}>Slow</Link>
        <Link href={`${BASE}/slow/hello`}>Slow item</Link>
        <Link href={`${BASE}/team`}>Team</Link>
        <Link href={`${BASE}/team/roster`}>Roster</Link>
        <Link href={`${BASE}/crew`}>Crew</Link>
      </nav>
      {children}
    </div>
  );
}
