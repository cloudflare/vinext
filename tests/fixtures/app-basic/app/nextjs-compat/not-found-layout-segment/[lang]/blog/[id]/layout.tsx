/**
 * Test fixture: layout that calls notFound() for invalid ids, with no deeper
 * not-found, so the [lang] boundary's metadata becomes the page's metadata.
 */
import { notFound } from "next/navigation";

export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;

  if (id !== "hello") {
    notFound();
  }

  return children;
}
