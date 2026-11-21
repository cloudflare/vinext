import { Suspense } from "react";
import { EffectProbe } from "../../effect-probe";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <>
      <h2>Chat {id}</h2>
      <Suspense fallback={<div>Loading...</div>}>
        <EffectProbe name={`chat:${id}`} />
      </Suspense>
    </>
  );
}
