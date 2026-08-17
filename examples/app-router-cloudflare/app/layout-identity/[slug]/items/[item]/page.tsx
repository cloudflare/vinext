import Link from "next/link";

export default async function ItemPage({
  params,
}: {
  params: Promise<{ slug: string; item: string }>;
}) {
  const { slug, item } = await params;

  return (
    <main>
      <h1 data-testid="page-title">Item page</h1>
      <p data-testid="item-value">Item: {item}</p>
      <Link data-testid="to-parent" href={`/layout-identity/${slug}`}>
        Back to parent
      </Link>
    </main>
  );
}
