/**
 * Dynamic page that calls forbidden() when id=403.
 * Ported from: test/e2e/app-dir/forbidden/basic/app/dynamic/[id]/page.js
 */
import { forbidden } from "next/navigation";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (id === "403") {
    forbidden();
  }

  return <p id="page">{`dynamic [id]`}</p>;
}
