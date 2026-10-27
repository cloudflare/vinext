export const dynamic = "force-dynamic";

export default async function DynamicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const renderToken = crypto.randomUUID();
  return (
    <main>
      <h1>Dynamic vinext load test</h1>
      <output data-cache-kind="dynamic" data-id={id} data-render-token={renderToken}>
        {renderToken}
      </output>
    </main>
  );
}
