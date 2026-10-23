import { notFound } from "next/navigation";

export default async function Team({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "missing" || id === "both" || id === "late") notFound();
  return <p id="slot-own-team">Team {id}</p>;
}
