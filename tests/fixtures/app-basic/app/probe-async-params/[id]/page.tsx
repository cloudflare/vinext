import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const VALID_IDS = ["valid-1", "valid-2"];

// Uses the Next.js 15+ async params pattern: destructures after await.
// If probePage() passes raw null-prototype params instead of thenable params,
// `await params` throws TypeError and the probe silently fails, meaning
// notFound() is never detected early.
export default async function ProbeAsyncParamsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!VALID_IDS.includes(id)) {
    notFound();
  }

  return <p id="probe-async-params-page">Probe async params: {id}</p>;
}
