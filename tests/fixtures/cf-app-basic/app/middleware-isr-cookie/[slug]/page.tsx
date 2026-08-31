export const revalidate = 60;

export default async function MiddlewareIsrCookiePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const renderToken = crypto.randomUUID();
  return (
    <main data-slug={slug} data-render-token={renderToken}>
      Middleware cookie ISR page render-token:{renderToken}
    </main>
  );
}
