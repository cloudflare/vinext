export const revalidate = 60;

export default async function MatcherExcludedAppPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main data-slug={slug} data-render-token={crypto.randomUUID()}>
      Matcher-excluded App ISR page
    </main>
  );
}
