/**
 * The remaining slots of the provider pyramid. Each one is small, but their
 * nesting order is load-bearing:
 * sign-in > copy > formatting > viewport > runtime-settings > critique >
 * graph-handle > edge-probe > trials > side-panel.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";

// --- Sign-in state ---------------------------------------------------------

type SignInState = {
  standing: "guest" | "known";
  faulted: boolean;
};

const SignInContext = createContext<SignInState>({
  standing: "guest",
  faulted: false,
});

export const SignInStateProvider = ({
  withSessionBridge,
  surfaceFaults,
  children,
}: {
  withSessionBridge?: boolean;
  surfaceFaults?: boolean;
  children: React.ReactNode;
}) => {
  const value = useMemo<SignInState>(
    () => ({
      standing: withSessionBridge ? "guest" : "guest",
      faulted: surfaceFaults ? false : false,
    }),
    [withSessionBridge, surfaceFaults],
  );
  return <SignInContext.Provider value={value}>{children}</SignInContext.Provider>;
};

export const useSignInState = () => useContext(SignInContext);

// --- Viewport band ---------------------------------------------------------

type ViewportBand = "narrow" | "mid" | "broad";

const ViewportBandContext = createContext<ViewportBand>("broad");

export const ViewportBandProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [band, setBand] = useState<ViewportBand>("broad");

  useEffect(() => {
    const measure = () =>
      setBand(
        window.innerWidth < 640 ? "narrow" : window.innerWidth < 1024 ? "mid" : "broad",
      );
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <ViewportBandContext.Provider value={band}>
      {children}
    </ViewportBandContext.Provider>
  );
};

export const useViewportBand = () => useContext(ViewportBandContext);

// --- Critique portal settings ---------------------------------------------

type CritiquePortalSettings = {
  expressEndpoint: string;
  gatewayRest?: { baseUrl: string; apiKey: string };
};

const CritiquePortalContext = createContext<CritiquePortalSettings>({
  expressEndpoint: "",
});

export const CritiquePortalProvider = ({
  settings,
  children,
}: {
  settings: CritiquePortalSettings;
  children: React.ReactNode;
}) => (
  <CritiquePortalContext.Provider value={settings}>
    {children}
  </CritiquePortalContext.Provider>
);

export const useCritiquePortal = () => useContext(CritiquePortalContext);

// --- Edge-probe (edge-injected experimentation) data -----------------------

export type EdgeProbeData = Record<string, unknown>;

const EdgeProbeContext = createContext<{
  data: EdgeProbeData;
  hasActiveProbe: (id: number) => boolean;
}>({ data: {}, hasActiveProbe: () => false });

export const EdgeProbeProvider = ({
  data = {},
  children,
}: {
  data?: EdgeProbeData;
  children: React.ReactNode;
}) => {
  const value = useMemo(
    () => ({
      data,
      hasActiveProbe: (id: number) =>
        Array.isArray(data["activeProbes"]) &&
        (data["activeProbes"] as number[]).includes(id),
    }),
    [data],
  );
  return <EdgeProbeContext.Provider value={value}>{children}</EdgeProbeContext.Provider>;
};

export const useEdgeProbe = () => useContext(EdgeProbeContext);

// --- Side panel (slide-out surface fed by the data edge) -------------------

const SidePanelContext = createContext<{
  dataEdgeUrl: string;
  isOpen: boolean;
  setOpen: (open: boolean) => void;
}>({ dataEdgeUrl: "", isOpen: false, setOpen: () => {} });

export const SidePanelProvider = ({
  dataEdgeUrl,
  children,
}: {
  dataEdgeUrl: string;
  children: React.ReactNode;
}) => {
  const [isOpen, setOpen] = useState(false);
  const value = useMemo(
    () => ({ dataEdgeUrl, isOpen, setOpen }),
    [dataEdgeUrl, isOpen],
  );
  return (
    <SidePanelContext.Provider value={value}>{children}</SidePanelContext.Provider>
  );
};

export const useSidePanel = () => useContext(SidePanelContext);

// --- Engagement kit hook ---------------------------------------------------

export const useEngageKit = ({
  product,
  engageSettings,
}: {
  product: string;
  engageSettings: { appId?: string; apiKey?: string };
}): void => {
  useEffect(() => {
    if (engageSettings.appId && engageSettings.apiKey) {
      // A real integration would boot a third-party SDK here.
      (window as unknown as Record<string, unknown>)["__ATLAS_ENGAGE__"] = {
        product,
        appId: engageSettings.appId,
      };
    }
  }, [product, engageSettings.appId, engageSettings.apiKey]);
};

// --- Beacon consent hook ---------------------------------------------------

export const useBeaconConsent = (): void => {
  useEffect(() => {
    // Consent tooling would gate the beacon sink here; the hook slot itself
    // is what the shell architecture requires.
  }, []);
};
