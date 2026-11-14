// The path vinext requests for the 404 page is generated here too, so it must
// still render as this page.
export function generateStaticParams() {
  return [{ slug: "hello" }, { slug: "__vinext_nonexistent_for_404__" }];
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p>slug page: {slug}</p>;
}
