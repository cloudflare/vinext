import Link from "next/link";

export default async function LayoutIdentityChildPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <main>
      <h1 data-testid="page-title">Child page</h1>
      <Link data-testid="to-parent" href={`/layout-identity/${slug}`}>
        Back to parent
      </Link>
    </main>
  );
}
