import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Uses the Next.js 15+ async searchParams pattern: destructures after await.
// If probePage() omits searchParams entirely, `await searchParams` throws
// TypeError and the probe silently fails, meaning redirect() is never
// detected early.
export default async function ProbeAsyncSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ dest?: string }>;
}) {
  const { dest } = await searchParams;

  if (dest) {
    redirect(dest);
  }

  return <p id="probe-async-search-page">No redirect destination</p>;
}
