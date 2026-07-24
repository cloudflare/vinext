import { createContext, useContext, useEffect, useMemo } from "react";

import { emitBeacon } from "../beacon/emit";
import { useResetTrialMarks } from "./use-reset-trial-marks";

export type TrialArm = {
  enabled: boolean;
  armKey?: string;
  knobs?: Record<string, unknown>;
};

type TrialsContextValue = {
  attributes: Record<string, unknown>;
  arm: (flag: string) => TrialArm | undefined;
};

const TrialsContext = createContext<TrialsContextValue>({
  attributes: {},
  arm: () => undefined,
});

declare global {
  interface Window {
    __ATLAS_TRIALS_MANIFEST__?: Record<string, TrialArm>;
    __ATLAS_TRIALS_SDK_KEY__?: string | null;
  }
}

/** Records which flags the current page consulted (reset on navigation). */
const markTrialActive = (flag: string) => {
  if (typeof window === "undefined") {
    return;
  }
  window.__ATLAS_TRIALS_ACTIVE__ = window.__ATLAS_TRIALS_ACTIVE__ ?? [];
  if (!window.__ATLAS_TRIALS_ACTIVE__.includes(flag)) {
    window.__ATLAS_TRIALS_ACTIVE__.push(flag);
  }
};

/**
 * Static arms keyed by flag. A real deployment would consult the manifest
 * fetched by the _document bootstrap snippet; keeping deterministic fallbacks
 * preserves the arm()/knobs surface without a third-party SDK.
 */
const STATIC_ARMS: Record<string, TrialArm> = {
  launch_timer: {
    enabled: true,
    armKey: "armed",
    knobs: { timer_deadline: "2027-01-01T00:00:00Z" },
  },
  tight_asset_policy: {
    enabled: false,
  },
};

export const TrialsProvider = ({
  seedAttributes = {},
  children,
}: {
  seedAttributes?: Record<string, unknown>;
  children: React.ReactNode;
}) => {
  // The provider owns the navigation-reset wiring so every consumer of the
  // trials context gets per-page mark hygiene for free.
  useResetTrialMarks();

  const value = useMemo<TrialsContextValue>(
    () => ({
      attributes: seedAttributes,
      arm: (flag) => {
        markTrialActive(flag);
        return (
          (typeof window !== "undefined" &&
            window.__ATLAS_TRIALS_MANIFEST__?.[flag]) ||
          STATIC_ARMS[flag]
        );
      },
    }),
    [seedAttributes],
  );

  return <TrialsContext.Provider value={value}>{children}</TrialsContext.Provider>;
};

export const useTrialArm = (flag: string): TrialArm | undefined =>
  useContext(TrialsContext).arm(flag);

/** Server-side arm helper consulted from getServerSideProps. */
export const tightAssetPolicyArm = async (_ctx: {
  canonicalPath?: string;
}): Promise<{ enabled: boolean; reportOnly: boolean }> => {
  const arm = STATIC_ARMS["tight_asset_policy"];
  return {
    enabled: arm?.enabled ?? false,
    reportOnly: true,
  };
};

/** Re-arms the client-side trials agent after hydration. */
export const rearmTrials = (): void => {
  emitBeacon("trials-rearmed");
};

export const useTrialsBeacon = ({
  product,
  active,
}: {
  product: string;
  active: boolean;
}): void => {
  useEffect(() => {
    if (active) {
      emitBeacon("trials-beacon", { product });
    }
  }, [product, active]);
};

/**
 * Inline bootstrap injected by _document with `beforeInteractive` strategy:
 * fetches the trials manifest as early as possible and parks it on a window
 * global for the provider to pick up.
 */
export const trialsBootstrapSnippet = (sdkKey: string | undefined): string =>
  sdkKey
    ? [
        `window.__ATLAS_TRIALS_SDK_KEY__=${JSON.stringify(sdkKey)};`,
        `fetch("/api/trials-manifest?key="+encodeURIComponent(${JSON.stringify(sdkKey)}))`,
        `.then((r)=>r.json())`,
        `.then((m)=>{window.__ATLAS_TRIALS_MANIFEST__=m;})`,
        `.catch(()=>{});`,
      ].join("")
    : `window.__ATLAS_TRIALS_SDK_KEY__=null;`;

/** Static manifest served by /api/trials-manifest. */
export const trialsManifest = (): Record<string, TrialArm> => STATIC_ARMS;
