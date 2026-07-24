export type Beacon = {
  name: string;
  attributes: Record<string, unknown>;
  at: number;
};

declare global {
  interface Window {
    __ATLAS_BEACONS__?: Beacon[];
  }
}

/**
 * Isomorphic beacon sink. In the browser, beacons accumulate on
 * `window.__ATLAS_BEACONS__` (the stand-in for a RUM agent) so end-to-end
 * tests can assert on them; on the server they go to stdout.
 */
export const emitBeacon = (
  name: string,
  attributes: Record<string, unknown> = {},
): void => {
  if (typeof window === "undefined") {
    console.log(`[beacon] ${name}`, JSON.stringify(attributes));
    return;
  }
  window.__ATLAS_BEACONS__ = window.__ATLAS_BEACONS__ ?? [];
  window.__ATLAS_BEACONS__.push({ name, attributes, at: Date.now() });
};
