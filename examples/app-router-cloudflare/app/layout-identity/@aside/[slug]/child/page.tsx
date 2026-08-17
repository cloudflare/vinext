export default async function AsideChild({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p data-testid="aside-content">aside: {slug} child</p>;
}
