export const LANDING_RACE_PLAYED_KEY = "vinext:landing-race-played";
export const LANDING_SWAP_PLAYED_KEY = "vinext:landing-swap-played";

export type LandingPlaybackKey = typeof LANDING_RACE_PLAYED_KEY | typeof LANDING_SWAP_PLAYED_KEY;

type LandingPlaybackStorage = Pick<Storage, "getItem" | "setItem">;

export function getLandingPlaybackStorage(): LandingPlaybackStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    // Accessing the storage object itself can throw for opaque or restricted origins.
    return null;
  }
}

export function hasLandingSequencePlayed(
  storage: LandingPlaybackStorage | null,
  key: LandingPlaybackKey,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(key) === "1";
  } catch {
    // Storage can be unavailable in privacy-restricted contexts. Replaying is
    // safer than hiding an explanatory sequence behind failed persistence.
    return false;
  }
}

export function markLandingSequencePlayed(
  storage: LandingPlaybackStorage | null,
  key: LandingPlaybackKey,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, "1");
  } catch {
    // Motion remains functional when storage is unavailable; it simply cannot
    // persist its one-play state across navigation.
  }
}
