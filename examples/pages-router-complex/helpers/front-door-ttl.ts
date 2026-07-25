/**
 * The front door's surrogate TTL is tunable at runtime (ops can shorten it
 * during launches). Async because the real lookup consults a config service.
 */
export const readFrontDoorTtl = async (): Promise<{ frontDoorTtl: number }> => {
  const raw = process.env["ATLAS_FRONT_DOOR_TTL"];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return {
    frontDoorTtl: Number.isFinite(parsed) && parsed > 0 ? parsed : 900,
  };
};
