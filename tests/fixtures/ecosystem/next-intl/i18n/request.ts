import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";

const locales = ["en", "de"] as const;

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const resolvedLocale = hasLocale(locales, requested) ? requested : "en";
  return {
    locale: resolvedLocale,
    messages: (await import(`../messages/${resolvedLocale}.json`)).default,
  };
});
