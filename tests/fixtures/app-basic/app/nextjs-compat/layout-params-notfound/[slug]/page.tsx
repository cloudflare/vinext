import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const VALID_SLUGS = ["hello", "world"];

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (!VALID_SLUGS.includes(slug)) {
    notFound();
  }

  return <p id="layout-params-notfound-page">Page content for: {slug}</p>;
}
