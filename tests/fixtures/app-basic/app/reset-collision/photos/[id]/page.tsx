export default async function PhotosCollisionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main>
      <h1 data-testid="photos-page">Photos {id}</h1>
    </main>
  );
}
