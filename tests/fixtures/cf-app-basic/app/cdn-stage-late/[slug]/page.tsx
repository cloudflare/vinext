import { Suspense } from "react";
import { headers } from "next/headers";

// Default-static pages use an infinite revalidation interval internally. This
// exercises the client-header-preservation path as well as ordinary ISR.
export const revalidate = false;

async function LateDynamicContent({ slug }: { slug: string }) {
  // Ensure the response stream has started before dynamic request state is
  // accessed. The completed response must not be promoted to a shared cache.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const visitorId = (await headers()).get("x-test-visitor-id") ?? "anonymous";
  const renderToken = crypto.randomUUID();

  return (
    <span data-render-token={renderToken}>
      {`late-dynamic-visitor:${visitorId}; slug:${slug}; render-token:${renderToken}`}
    </span>
  );
}

export default async function CdnStageLatePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  return (
    <main>
      <Suspense fallback={<span>loading-late-dynamic-content</span>}>
        <LateDynamicContent slug={slug} />
      </Suspense>
    </main>
  );
}
