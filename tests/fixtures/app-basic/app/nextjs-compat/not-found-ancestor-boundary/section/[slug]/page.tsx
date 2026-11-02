import { notFound } from "next/navigation";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug === "missing") {
    notFound();
  }
  return <p id="not-found-ancestor-boundary-page">Section page: {slug}</p>;
}
