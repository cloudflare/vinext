import { redirect } from "next/navigation";

export const revalidate = 60;

export default async function CdnStageAppPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug === "redirect") redirect("/about");
  const renderToken = crypto.randomUUID();
  return (
    <main data-render-token={renderToken} data-slug={slug}>
      App CDN response stage render-token:{renderToken}
    </main>
  );
}
