import { createContext, useContext } from "react";

import type { PublicSettings } from "../runtime-settings/settings";

export type RuntimeSettingsValue = PublicSettings & {
  lookupApiKey?: string;
  gatewayRest?: {
    baseUrl: string;
    apiKey: string;
  };
};

export const RuntimeSettingsContext = createContext<RuntimeSettingsValue>({
  dataEdge: { url: "/api/graph", token: "" },
});

export const RuntimeSettingsProvider = ({
  value,
  children,
}: {
  value: RuntimeSettingsValue;
  children: React.ReactNode;
}) => (
  <RuntimeSettingsContext.Provider value={value}>
    {children}
  </RuntimeSettingsContext.Provider>
);

export const useRuntimeSettings = () => useContext(RuntimeSettingsContext);
