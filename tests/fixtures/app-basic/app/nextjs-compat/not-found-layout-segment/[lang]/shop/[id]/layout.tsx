/**
 * Test fixture: layout that calls notFound() for invalid ids.
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

  return <div id="not-found-layout-segment-wrapper">{children}</div>;
}
