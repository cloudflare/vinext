/**
 * Test fixture data. Kept out of the browser bundle via the
 * module-replacement hook in next.config.js (it historically leaked through
 * a barrel re-export).
 */
export const mockWallData = {
  wallPath: "/gallery/skies/clips",
  assets: Array.from({ length: 24 }, (_, i) => ({
    assetId: `cl9${i}00`,
    title: `Mock asset ${i}`,
  })),
};
