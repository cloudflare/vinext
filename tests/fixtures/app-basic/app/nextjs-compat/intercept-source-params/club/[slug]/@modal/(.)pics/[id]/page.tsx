export default async function PicModal({
  params,
}: {
  params: Promise<{ id: string; slug: string }>;
}) {
  const { id, slug } = await params;
  return (
    <p id="intercept-source-params-modal">
      Pic modal: {slug}/{id}
    </p>
  );
}
