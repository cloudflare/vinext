export default async function FullPhotoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <h1 id="dynamic-interception-revalidate-full">Full Photo {id}</h1>;
}
