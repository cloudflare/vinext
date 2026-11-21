import { EffectProbe } from "../../../effect-probe";

export default async function PanelMore({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <h2>Panels {id} more</h2>
      <EffectProbe name={`panel-more:${id}`} />
    </>
  );
}

export function generateStaticParams() {
  return ["a", "b", "c", "d"].map((id) => ({ id }));
}
