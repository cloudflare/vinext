import { EffectProbe } from "../../effect-probe";
import { StatusLink } from "../../../link-status/status-link";

export default async function PanelMain({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <h2>Panels {id}</h2>
      <EffectProbe name={`panel-main:${id}`} />
      <StatusLink
        href={`/bfcache-effects/panels/${id}/more`}
        id={`panel-${id}-more`}
        label="More"
      />
    </>
  );
}

export function generateStaticParams() {
  return ["a", "b", "c", "d"].map((id) => ({ id }));
}
