/**
 * Test fixture: layout that calls notFound() for invalid slugs.
 * Both this layout AND the page validate the slug — this tests that the
 * layout's notFound() is caught first (before the page's notFound()),
 * matching Next.js behavior where layouts render before their children.
 *
 * Without correct pre-render ordering, the page's notFound() is caught first,
 * and renderHTTPAccessFallbackPage includes this layout (which also throws),
 * causing a 500 error.
 */
import { notFound } from "next/navigation";

const VALID_SLUGS = ["hello", "world"];

export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: React.ReactNode;
}) {
  const { slug } = await params;

  if (!VALID_SLUGS.includes(slug)) {
    notFound();
  }

  return (
    <div id="not-found-layout-page-wrapper">
      <h2>Slug: {slug}</h2>
      {children}
    </div>
  );
}
