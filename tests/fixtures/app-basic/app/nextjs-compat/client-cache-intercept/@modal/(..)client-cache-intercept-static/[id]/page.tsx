// No generateStaticParams: Next.js renders this intercepting page on every
// request (ƒ), even though its target page is static.
export default async function ClientCacheInterceptDynamicModal({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div id="client-cache-intercept-dynamic-modal">
      {id}:{Math.random()}
    </div>
  );
}
