import { RoomClient } from "./room-client";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <RoomClient roomId={id} />;
}
