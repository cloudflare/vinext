export function generateStaticParams({ params }: { params: { category?: string; slug?: string } }) {
  if (params.category !== "docs" || params.slug !== undefined) {
    throw new Error("expected only parent category params");
  }

  return [{ slug: "intro" }];
}

export default async function Page({
  params,
}: {
  params: Promise<{ category: string; slug: string }>;
}) {
  const { category, slug } = await params;
  return (
    <p data-testid="layout-segment-config-nested-gsp">
      Nested GSP {category}/{slug}
    </p>
  );
}
