import Link from "next/link";

// A dynamic source below the locale root. Middleware rewrites the unprefixed
// `/interception-mw/tags/<tag>` to `/interception-mw/en/tags/<tag>`.
export default async function Page({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  return (
    <div>
      <p id="tag-param">{tag}</p>
      <Link href="/interception-mw/foo/p/1" id="link-foo-p-1">
        Foo
      </Link>
    </div>
  );
}
