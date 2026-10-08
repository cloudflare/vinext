export default async function EncodedSiblingDynamicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <p data-testid="encoded-sibling">{`dynamic sibling ${slug}`}</p>;
}
