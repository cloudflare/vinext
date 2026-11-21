// Used by E2E: app-router/multiple-root-layouts.spec.ts.
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "listed" }];
}

export default async function ClosedPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p id="closed-page">{`closed page ${slug}`}</p>;
}
