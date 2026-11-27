import { VtBoundary } from "../../vt-boundary";

// The test holds this page's RSC response, so its loading shell commits first.
export default async function ViewTransitionTypesSlowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <VtBoundary name={`slow-${id}`}>
      <h1 data-testid={`vt-slow-${id}`}>slow page {id}</h1>
    </VtBoundary>
  );
}
