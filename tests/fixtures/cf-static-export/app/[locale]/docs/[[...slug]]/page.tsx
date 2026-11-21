export function generateStaticParams() {
  return [{ slug: ["known"] }];
}

export default async function Docs({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  return <h1>Docs {slug?.join("/") ?? "index"}</h1>;
}
