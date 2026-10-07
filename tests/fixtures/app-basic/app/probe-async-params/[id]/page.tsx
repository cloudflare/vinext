import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const VALID_IDS = ["valid-1", "valid-2"];

// Uses the Next.js 15+ async params pattern: destructures after await, then
// calls notFound().
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
