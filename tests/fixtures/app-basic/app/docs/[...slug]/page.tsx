export default function DocsPage({ params }: { params: { slug: string[] } }) {
  return (
    <main>
      <h1>Documentation</h1>
      <p>Path: {params.slug.join("/")}</p>
      <p>Segments: {params.slug.length}</p>
    </main>
  );
}
