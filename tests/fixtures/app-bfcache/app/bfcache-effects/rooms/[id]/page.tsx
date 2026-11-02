import { EffectProbe } from "../../effect-probe";
import { StatusLink } from "../../../link-status/status-link";

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <>
      <h2>Room {id}</h2>
      <EffectProbe name={`room:${id}`} />
      <StatusLink
        href={`/bfcache-effects/rooms/${id === "a" ? "b" : "a"}`}
        id={`room-${id}-switch`}
        label="Switch room"
      />
    </>
  );
}
