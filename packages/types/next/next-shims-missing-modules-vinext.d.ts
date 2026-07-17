declare module "next/config" {
  type RuntimeConfig = {
    serverRuntimeConfig: Record<string, unknown>;
    publicRuntimeConfig: Record<string, unknown>;
  };
  export default function getConfig(): RuntimeConfig;
}

declare module "next/amp" {
  export function useAmp(): boolean;
  export function isInAmpMode(): boolean;
}

declare module "next/offline" {
  export function useOffline(): boolean;
}
