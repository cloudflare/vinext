/**
 * Dynamic page without a local forbidden boundary.
 * When id=403, forbidden() should escalate to the root forbidden boundary.
 * Ported from: test/e2e/app-dir/forbidden/basic/app/dynamic-layout-without-forbidden/[id]/page.js
 */
import { forbidden } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (id === "403") {
    forbidden();
  }

  return <p id="page">{`dynamic-no-boundary [id]`}</p>;
}
