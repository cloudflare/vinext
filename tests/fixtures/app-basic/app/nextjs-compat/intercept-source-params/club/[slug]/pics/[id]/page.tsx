export default async function PicPage({
  params,
}: {
  params: Promise<{ id: string; slug: string }>;
}) {
  const { id, slug } = await params;
  return (
    <p id="intercept-source-params-pic">
      Pic page: {slug}/{id}
    </p>
  );
}
