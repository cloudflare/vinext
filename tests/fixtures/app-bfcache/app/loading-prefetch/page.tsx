import Link from "next/link";

// Links to pages under loading.tsx, which Next.js prefetches as static shells.
export default function LoadingPrefetchLinks() {
  return (
    <main>
      <Link id="link-static" href="/loading-prefetch/static">
        static
      </Link>
      <Link id="link-holed" href="/loading-prefetch/holed">
        holed
      </Link>
      <Link id="link-top" href="/loading-prefetch/top">
        top
      </Link>
      <Link id="link-soon-stale" href="/loading-prefetch/soon-stale">
        soon-stale
      </Link>
    </main>
  );
}
