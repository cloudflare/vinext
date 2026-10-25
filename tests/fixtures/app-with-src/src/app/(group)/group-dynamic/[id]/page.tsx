import { forbidden, unauthorized } from "next/navigation";

// Ported from Next.js: test/e2e/app-dir/forbidden/default/app/(group)/group-dynamic/[id]/page.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/forbidden/default/app/(group)/group-dynamic/[id]/page.js
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "403") forbidden();
  if (id === "401") unauthorized();
  return <p id="page">group-dynamic [id]</p>;
}
