export default async function LateCookiePhotoModal({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <aside id="late-cookie-layout-photo-modal">Photo modal {id}</aside>;
}
