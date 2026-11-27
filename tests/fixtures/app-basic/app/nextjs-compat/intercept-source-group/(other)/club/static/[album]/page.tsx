import Link from "next/link";

// A page beside `(shared)/club/[slug]`, without its modal slot, at a path
// the intercepting route `club/[slug]/@modal/[album]/(.)tracks/[id]` covers.
export default function StaticAlbumPage() {
  return (
    <div id="intercept-source-group-static-album">
      <Link href="/nextjs-compat/intercept-source-group/club/acme/two/tracks/1">Track 1</Link>
    </div>
  );
}
