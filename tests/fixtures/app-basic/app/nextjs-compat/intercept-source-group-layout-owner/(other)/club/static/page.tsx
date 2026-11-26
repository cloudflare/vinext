import Link from "next/link";

// A static page beside `(shared)/club/[slug]`, without its modal slot.
export default function StaticClubPage() {
  return (
    <div id="intercept-layout-owner-static">
      <Link href="/nextjs-compat/intercept-source-group-layout-owner/club/static/pics/1">
        Pic 1
      </Link>
    </div>
  );
}
