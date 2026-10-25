export default async function Roster({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="slot-own-roster">Roster {id}</p>;
}
