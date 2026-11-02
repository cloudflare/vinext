import { EffectProbe } from "../../../../effect-probe";

export default async function PanelSlotMore({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EffectProbe name={`panel-slot-more:${id}`} />;
}

export function generateStaticParams() {
  return ["a", "b", "c", "d"].map((id) => ({ id }));
}
