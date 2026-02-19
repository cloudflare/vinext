/**
 * Test fixture: layout that calls notFound() for invalid slugs.
 * Tests that notFound() from a layout is caught by the parent boundary.
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
    <div id="not-found-layout-wrapper">
      <h2>Slug: {slug}</h2>
      {children}
    </div>
  );
}
