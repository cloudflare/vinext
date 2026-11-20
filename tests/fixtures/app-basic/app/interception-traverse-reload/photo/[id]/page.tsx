export default async function InterceptionTraverseReloadPhotoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div id="interception-traverse-reload-photo-page">
      <h1>Photo page {id}</h1>
    </div>
  );
}
