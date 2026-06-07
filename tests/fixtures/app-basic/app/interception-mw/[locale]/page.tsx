import Link from "next/link";

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <div>
      {/* Link without locale — middleware rewrites /interception-mw/foo/p/1
          to /interception-mw/en/foo/p/1 so interception fires */}
      <Link href="/interception-mw/foo/p/1" id="link-foo-p-1">
        Foo
      </Link>
    </div>
  );
}
