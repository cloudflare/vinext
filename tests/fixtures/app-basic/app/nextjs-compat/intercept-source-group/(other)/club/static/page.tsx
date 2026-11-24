import Link from "next/link";

// A static page beside `(shared)/club/[slug]`, without its modal slot.
export default function StaticClubPage() {
  return (
    <div id="intercept-source-group-static">
      <p>Static club</p>
      <Link href="/nextjs-compat/intercept-source-group/club/static/pics/1">Pic 1</Link>
      <Link href="/nextjs-compat/intercept-source-group/club/acme/pics/1">Acme pic 1</Link>
    </div>
  );
}
