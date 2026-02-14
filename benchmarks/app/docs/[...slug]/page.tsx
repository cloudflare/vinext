export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return { title: `Docs: ${slug.join(" / ")}` };
}
export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  return (<div><h1>Docs: {slug.join(" / ")}</h1>{Array.from({ length: 3 }, (_, i) => <p key={i}>Section {i + 1} content.</p>)}</div>);
}

