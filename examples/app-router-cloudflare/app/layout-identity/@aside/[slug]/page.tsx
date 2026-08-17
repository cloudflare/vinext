export default async function AsideParent({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p data-testid="aside-content">aside: {slug} parent</p>;
}
