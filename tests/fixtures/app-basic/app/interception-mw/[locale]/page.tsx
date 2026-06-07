import Link from "next/link";

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <div>
      <Link href={`/interception-mw/${locale}/foo/p/1`} id="link-foo-p-1">
        Foo
      </Link>
    </div>
  );
}
