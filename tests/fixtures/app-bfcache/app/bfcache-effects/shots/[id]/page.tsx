import { Suspense } from "react";
import { EffectProbe } from "../../effect-probe";

export function generateStaticParams() {
  return ["1", "2", "3"].map((id) => ({ id }));
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <>
      <h2>Shot {id}</h2>
      <Suspense fallback={<div>Loading...</div>}>
        <EffectProbe name={`shot:${id}`} />
      </Suspense>
    </>
  );
}
