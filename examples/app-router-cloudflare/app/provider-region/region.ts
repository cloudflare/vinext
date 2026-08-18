export function getRequestRegion(headers: Headers, fallback = "US"): string {
  return headers.get("cf-ipcountry") ?? fallback;
}

export const providersByRegion = {
  AU: [
    { id: 8, name: "Netflix" },
    { id: 9, name: "Amazon Prime Video" },
    { id: 337, name: "Disney Plus" },
    { id: 385, name: "BINGE" },
  ],
  US: [
    { id: 8, name: "Netflix" },
    { id: 9, name: "Amazon Prime Video" },
    { id: 337, name: "Disney Plus" },
    { id: 1899, name: "Max" },
  ],
} as const;

export function getProvidersForRegion(region: string) {
  return region === "AU" ? providersByRegion.AU : providersByRegion.US;
}
