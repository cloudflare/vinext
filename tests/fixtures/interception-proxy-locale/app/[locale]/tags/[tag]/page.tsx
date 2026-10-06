import Link from "next/link";

// A dynamic source segment whose value can be percent-encoded in the URL.
export default function Page() {
  return (
    <>
      <p>TAG-SOURCE</p>
      <Link href="/foo/p/1">Foo</Link>
    </>
  );
}
