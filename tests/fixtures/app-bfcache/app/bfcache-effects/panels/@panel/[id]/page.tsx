import { EffectProbe } from "../../../effect-probe";
import { ThrowButton } from "../../../throw-button";

export default async function PanelSlot({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <EffectProbe name={`panel:${id}`} />
      <ThrowButton name={`panel:${id}`} />
    </>
  );
}

export function generateStaticParams() {
  return ["a", "b", "c", "d"].map((id) => ({ id }));
}
