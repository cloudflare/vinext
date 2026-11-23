export default async function ShelfPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p>{`SECRET-SHELF-CONTENT:${slug}`}</p>;
}
