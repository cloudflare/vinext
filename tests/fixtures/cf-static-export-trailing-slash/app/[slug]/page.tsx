export function generateStaticParams() {
  return [{ slug: "about" }];
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <h1>Page {slug}</h1>;
}
