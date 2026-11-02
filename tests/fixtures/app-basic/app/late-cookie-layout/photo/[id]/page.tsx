export default async function LateCookiePhotoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <h1>Photo {id}</h1>;
}
