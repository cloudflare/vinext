export const revalidate = 60;

export default async function AppStagePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const renderToken = crypto.randomUUID();
  return (
    <main data-render-token={renderToken} data-slug={slug}>
      App HTTP stage render-token:{renderToken}
    </main>
  );
}
