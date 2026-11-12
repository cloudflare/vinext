import Link from "next/link";

// Two query strings of one page, visible together.
export default function SearchPrefetchTogether() {
  return (
    <main>
      <Link id="link-c" href="/search-prefetch/target?q=c">
        c
      </Link>
      <Link id="link-d" href="/search-prefetch/target?q=d">
        d
      </Link>
    </main>
  );
}
