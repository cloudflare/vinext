export default async function DynamicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  return <h1 id="dynamic-page-slug">Dynamic page slug: {slug}</h1>;
}
