export default async function MetadataMultiImagePage({
  params,
}: {
  params: Promise<{ size: string }>;
}) {
  const { size } = await params;

  return (
    <main>
      <h1>Metadata Multi Image {size}</h1>
      <p>generateImageMetadata route coverage</p>
    </main>
  );
}
