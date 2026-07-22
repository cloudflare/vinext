// Internal zero cache-node sentinel. BfcacheIdMap intentionally stores this
// raw sentinel for hydration entries while freshly-minted ids use the public
// "_b_N_" shape. The public hook formats "0" as "_b_0_" so user keys always
// see the same opaque format.
export const INITIAL_BFCACHE_ID = "0";
export const PUBLIC_INITIAL_BFCACHE_ID = "_b_0_";
