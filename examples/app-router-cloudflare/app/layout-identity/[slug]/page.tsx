import Link from "next/link";

export default async function LayoutIdentityPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <main>
      <h1 data-testid="page-title">Parent page</h1>
      <Link data-testid="to-child" href={`/layout-identity/${slug}/child`}>
        Go to child
      </Link>
      <Link data-testid="to-item" href={`/layout-identity/${slug}/items/first`}>
        Go to item
      </Link>
    </main>
  );
}
