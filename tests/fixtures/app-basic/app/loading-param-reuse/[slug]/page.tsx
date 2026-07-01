export function generateStaticParams() {
  return [{ slug: "first" }, { slug: "second" }];
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <h1 data-testid="loading-param-page-slug">Page slug: {slug}</h1>;
}
