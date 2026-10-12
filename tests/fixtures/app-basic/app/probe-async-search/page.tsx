import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Uses the Next.js 15+ async searchParams pattern: destructures after await,
// then calls redirect().
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
