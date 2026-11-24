import Link from "next/link";

// A static page in another route group than `club/[slug]`, without its modal
// slot.
export default function StaticClubPage() {
  return (
    <div id="intercept-ancestor-slot-static">
      <Link href="/nextjs-compat/intercept-source-ancestor-slot/club/static/pics/1">Pic 1</Link>
    </div>
  );
}
