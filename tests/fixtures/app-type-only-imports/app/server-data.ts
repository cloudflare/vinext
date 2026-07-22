// Server-only module. Must never appear in the client module graph — it is
// only ever imported via inline `type` specifiers from client code.
export type ServerData = { secret: string };

export const SERVER_DATA_SENTINEL = "server-data-sentinel";
