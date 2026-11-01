import { notFound } from "next/navigation";

export default async function PhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "missing") notFound();
  return <p id="not-found-intercept-reset-modal">Photo modal: {id}</p>;
}
