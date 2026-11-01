import { Suspense } from "react";
import { EffectProbe } from "../../effect-probe";
import { StatusLink } from "../../../link-status/status-link";

export function generateStaticParams() {
  return ["1", "2", "3"].map((id) => ({ id }));
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <>
      <h2>Shot modal {id}</h2>
      <Suspense fallback={<div>Loading...</div>}>
        <EffectProbe name={`shot-modal:${id}`} />
      </Suspense>
      <StatusLink href="/bfcache-effects/shots" id={`shot-${id}-back`} label="Back to shots" />
      <StatusLink
        href={`/bfcache-effects/shots/${(Number(id) % 3) + 1}`}
        id={`shot-${id}-next`}
        label="Next shot"
      />
    </>
  );
}
