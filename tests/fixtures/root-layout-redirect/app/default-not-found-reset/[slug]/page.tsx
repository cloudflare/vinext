import { notFound } from "next/navigation";

export default async function DefaultNotFoundResetPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (slug === "missing") notFound();
  return <p id="default-not-found-reset-page">Page: {slug}</p>;
}
