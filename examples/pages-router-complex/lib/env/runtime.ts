export const runningInBrowser = (): boolean => typeof window !== "undefined";

export const isBlank = (value: unknown): value is null | undefined | "" =>
  value === null || value === undefined || value === "";
