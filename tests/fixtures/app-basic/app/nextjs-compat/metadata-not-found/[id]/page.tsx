import { notFound } from "next/navigation";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "missing") {
    notFound();
  }
  return <div>Dynamic page: {id}</div>;
}
