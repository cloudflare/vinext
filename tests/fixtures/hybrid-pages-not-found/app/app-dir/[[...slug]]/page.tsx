import { notFound } from "next/navigation";

export default async function CatchAll({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  if (!slug || slug.length !== 1 || slug[0] !== "about") notFound();
  return <h1>App catch-all</h1>;
}
