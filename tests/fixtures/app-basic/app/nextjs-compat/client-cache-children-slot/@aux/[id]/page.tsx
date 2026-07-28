export default async function Aux({ params }: { params: Promise<{ id: string }> }) {
  return <aside>Auxiliary {(await params).id}</aside>;
}
