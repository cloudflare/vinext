export const metadata = { title: "Pic modal" };

export default async function PicModal({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  return (
    <>
      <p id="intercept-source-group-modal">Pic modal: {id}</p>
      <p id="intercept-source-group-modal-club">Modal club: {slug}</p>
    </>
  );
}
