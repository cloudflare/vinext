import { notFound } from "next/navigation";

export default async function Members({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "missing") notFound();
  return <p id="slot-own-members">Members {id}</p>;
}
