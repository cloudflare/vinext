import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

export default async function PlainDynamicPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  // Streams the root not-found.tsx, whose boundary Next.js renders above the
  // ancestor loading.
  if (id === "missing") notFound();

  return (
    <>
      <h1 id="ancestor-shared-layout-dynamic">Plain {id} page</h1>
      <Link
        href="/ancestor-loading-shared-layout/plain/two"
        id="ancestor-shared-layout-two-from-dynamic-link"
      >
        Two
      </Link>
    </>
  );
}
