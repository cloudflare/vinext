import { Suspense } from "react";
import { EffectProbe } from "../../../effect-probe";
import { StatusLink } from "../../../../link-status/status-link";

export function generateStaticParams() {
  return ["1", "2", "3"].map((id) => ({ id }));
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <>
      <h2>Photo modal {id}</h2>
      <Suspense fallback={<div>Loading...</div>}>
        <EffectProbe name={`photo-modal:${id}`} />
      </Suspense>
      <StatusLink href="/bfcache-effects/gallery" id={`photo-${id}-back`} label="Back to gallery" />
    </>
  );
}
