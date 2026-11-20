export default async function OptimisticEncodedSlugPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <p id="slug-page">{`Slug ${slug}`}</p>;
}
