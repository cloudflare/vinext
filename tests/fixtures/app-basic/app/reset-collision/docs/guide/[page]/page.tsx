import { ErrorTrigger } from "../../../error-trigger";

export default async function DocsGuidePage({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;

  return (
    <main>
      <h1 data-testid="docs-guide-page">Docs guide {page}</h1>
      <ErrorTrigger label="docs" />
    </main>
  );
}
