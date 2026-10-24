import { notFound } from "next/navigation";

export const metadata = { title: "Team slot page" };

export default async function Team({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "missing" || id === "both" || id === "late" || id === "gone") notFound();
  return <p id="slot-own-team">Team {id}</p>;
}
