import type { ServerGraphHandle } from "../graph-handle/server";
import type { BroadcastPayload } from "../view/lifted-props";
import type { Zone } from "../zones/zone";

/**
 * Broadcast placement slots, kept as an enum with an awkward generated-code
 * alias (mirroring codegen'd enums that get renamed at import sites).
 */
export enum Syndication_BroadcastSlot {
  Ticker = "TICKER",
  Marquee = "MARQUEE",
}

export const fetchBroadcast = async (
  handle: ServerGraphHandle,
  {
    slot,
    audiences,
    zone,
    draft,
  }: {
    slot: Syndication_BroadcastSlot;
    audiences: string[];
    zone: Zone;
    draft?: boolean;
  },
): Promise<BroadcastPayload> => {
  const data = await handle.run<BroadcastPayload>("broadcastFor", {
    slot,
    audiences,
    zoneId: zone.id,
    draft: !!draft,
  });
  return data;
};

export const audiencesForZone = (zone: Zone): string[] => [
  `NETWORK_${zone.slug.toUpperCase()}`,
];
