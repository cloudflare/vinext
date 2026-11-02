import { EffectProbe, PageViewProbe } from "../../effect-probe";
import { RefreshButton } from "../../refresh-button";
import { StatusLink } from "../../../link-status/status-link";
import { revalidateRooms } from "../actions";

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <>
      <h2>Room {id}</h2>
      <EffectProbe name={`room:${id}`} />
      <PageViewProbe name={`room:${id}`} />
      <StatusLink
        href={`/bfcache-effects/rooms/${id === "a" ? "b" : "a"}`}
        id={`room-${id}-switch`}
        label="Switch room"
      />
      <RefreshButton />
      <form action={revalidateRooms}>
        <button data-testid={`revalidate-${id}`}>Revalidate</button>
      </form>
    </>
  );
}
