/**
 * Next.js compat: not-found/basic — dynamic page that calls notFound(), no local boundary
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/app/dynamic-layout-without-not-found/[id]/page.js
 *
 * There is NO not-found.tsx at this level or parent level — so notFound() should
 * escalate all the way up to the root not-found.tsx.
 */
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;

  if (id === "404") {
    notFound();
  }

  return <p id="page">not-found-no-boundary [id]</p>;
}
