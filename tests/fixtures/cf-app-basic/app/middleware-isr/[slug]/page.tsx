export const revalidate = 60;

export default async function MiddlewareIsrPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const renderToken = crypto.randomUUID();
  return (
    <main data-router="app" data-slug={slug} data-render-token={renderToken}>
      Middleware ISR page render-token:{renderToken}
    </main>
  );
}
