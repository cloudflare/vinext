import { cache } from "react";
import { headers } from "next/headers";

// Mirrors next-intl's static rendering: the locale lives in a React cache()
// value, with a request-header fallback when nothing was stored.
const getRequestLocaleStore = cache((): { locale: string | undefined } => ({
  locale: undefined,
}));

export function setRequestLocale(locale: string): void {
  getRequestLocaleStore().locale = locale;
}

export async function getRequestLocale(): Promise<string> {
  return getRequestLocaleStore().locale ?? (await headers()).get("x-request-locale") ?? "unset";
}
