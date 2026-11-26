export default async function PicModal({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  return (
    <p id="intercept-grouped-children-modal">
      Pic modal: {slug} {id}
    </p>
  );
}
