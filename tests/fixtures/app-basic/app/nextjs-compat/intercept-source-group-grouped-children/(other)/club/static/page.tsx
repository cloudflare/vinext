import Link from "next/link";

// A static page beside `(shared)/club/[slug]`, without its modal slot.
export default function StaticClubPage() {
  return (
    <div id="intercept-grouped-children-static">
      <Link href="/nextjs-compat/intercept-source-group-grouped-children/club/static/pics/1">
        Pic 1
      </Link>
    </div>
  );
}
