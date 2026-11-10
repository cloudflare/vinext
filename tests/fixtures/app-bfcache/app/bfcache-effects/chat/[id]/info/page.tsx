import { EffectProbe } from "../../../effect-probe";

export default async function ChatInfoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <>
      <h2>Info {id}</h2>
      <EffectProbe name={`info:${id}`} />
    </>
  );
}
