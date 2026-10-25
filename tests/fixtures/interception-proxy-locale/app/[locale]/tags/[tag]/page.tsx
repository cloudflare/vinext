import Link from "next/link";

// A dynamic source segment whose value can be percent-encoded in the URL.
export default async function Page({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  return (
    <>
      <p>TAG-SOURCE</p>
      <p>{`tag=${tag};`}</p>
      <Link href="/foo/p/1">Foo</Link>
    </>
  );
}
