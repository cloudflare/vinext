export const dynamic = "force-dynamic";

export default async function CacheablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const renderToken = crypto.randomUUID();
  return (
    <main>
      <h1>Response Store load test</h1>
      <output data-cache-kind="cacheable" data-id={id} data-render-token={renderToken}>
        {renderToken}
      </output>
    </main>
  );
}
