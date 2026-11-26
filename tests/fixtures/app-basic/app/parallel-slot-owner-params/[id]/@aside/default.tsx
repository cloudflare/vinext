export default async function AsideDefault({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p>aside default {id}</p>;
}
