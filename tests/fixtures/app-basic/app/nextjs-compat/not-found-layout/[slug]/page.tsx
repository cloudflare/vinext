/**
 * Test fixture: page under layout that validates slugs.
 */
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p id="not-found-layout-page">Content for: {slug}</p>;
}
