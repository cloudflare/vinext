export const revalidate = 60;

export default async function ConfigHeaderAppPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main data-slug={slug} data-render-token={crypto.randomUUID()}>
      Conditional config-header App ISR page
    </main>
  );
}
