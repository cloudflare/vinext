import { notFound } from "next/navigation";

export default async function PhotoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "missing") notFound();
  return <p id="not-found-intercept-reset-photo">Photo page: {id}</p>;
}
