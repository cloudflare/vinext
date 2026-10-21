/**
 * Test fixture: not-found boundary in a segment without a layout.
 * Catches notFound() thrown from shop/[id]/layout.tsx: a segment's boundary
 * wraps its children whether or not the segment has a layout. Its metadata,
 * with its own segment's params, is used when it is the route's deepest
 * not-found (blog/[id]).
 */
export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  return { title: `Not found (${lang})` };
}

export default function NotFound() {
  return <p id="not-found-layout-segment-nf">Not Found (segment without layout)</p>;
}
