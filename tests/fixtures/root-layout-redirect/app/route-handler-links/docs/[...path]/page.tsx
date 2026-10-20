export default async function DocsPage({ params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return <h1 data-testid="docs-page">Docs: {path.join("/")}</h1>;
}
