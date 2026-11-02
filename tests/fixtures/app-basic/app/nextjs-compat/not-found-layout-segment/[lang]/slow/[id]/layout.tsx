/**
 * Test fixture: layout below a loading.tsx that calls notFound() for invalid
 * ids. The server streams the loading shell first, so the [lang] boundary in
 * the rendered tree catches the signal.
 */
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  await new Promise((resolve) => setTimeout(resolve, 400));

  if (id !== "hello") {
    notFound();
  }

  return <div id="not-found-layout-segment-slow">{children}</div>;
}
