/**
 * Next.js compat: not-found/basic — dynamic [id] page that calls notFound() for id=404
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/app/dynamic/[id]/page.js
 */
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;

  if (id === "404") {
    notFound();
  }

  return <p id="page">dynamic [id]</p>;
}
