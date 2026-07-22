export default async function Page({ params }: { params: Promise<{ baz: string }> }) {
  const { baz } = await params;
  return <p>slot dynamic page: {baz}</p>;
}
