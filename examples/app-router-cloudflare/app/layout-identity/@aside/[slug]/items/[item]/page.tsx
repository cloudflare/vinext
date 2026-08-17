export default async function AsideItem({
  params,
}: {
  params: Promise<{ slug: string; item: string }>;
}) {
  const { slug, item } = await params;
  return (
    <p data-testid="aside-content">
      aside: {slug} / {item}
    </p>
  );
}
