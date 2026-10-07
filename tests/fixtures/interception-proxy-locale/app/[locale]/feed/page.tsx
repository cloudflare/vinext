import Link from "next/link";

// A source page below the locale root. Unprefixed, /feed also has the shape of
// /[locale] itself (with locale "feed"), which the root page / does not.
export default function Page() {
  return (
    <>
      <p>FEED-SOURCE</p>
      <Link href="/foo/p/1">Foo</Link>
    </>
  );
}
