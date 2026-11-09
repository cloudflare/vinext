import Link from "next/link";

// A static source segment that is percent-encoded in the URL.
export default function Page() {
  return (
    <>
      <p>CAFE-SOURCE</p>
      <Link href="/foo/p/1">Foo</Link>
    </>
  );
}
