export default async function MetadataDynamicStaticPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <main>
      <h1>Metadata Dynamic Static</h1>
      <p>Slug: {slug}</p>
    </main>
  );
}
