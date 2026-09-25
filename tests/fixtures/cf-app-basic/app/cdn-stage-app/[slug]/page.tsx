export const revalidate = 60;

// Next.js only ISR-caches a dynamic-segment route that exports
// generateStaticParams (an empty list opts every path into on-demand ISR).
export function generateStaticParams() {
  return [];
}

export default async function CdnStageAppPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const renderToken = crypto.randomUUID();
  return (
    <main data-render-token={renderToken} data-slug={slug}>
      App CDN response stage render-token:{renderToken}
    </main>
  );
}
