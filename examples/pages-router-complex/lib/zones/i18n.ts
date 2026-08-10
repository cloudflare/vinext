import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * Per-zone copy, bundled inline. The CA bundle is deliberately partial so
 * missing keys fall back to the base language at runtime.
 */
const copyByLanguage = {
  "en-US": {
    chrome: {
      skipLink: "Skip to primary region",
      lookupLabel: "Look something up",
    },
  },
  "en-CA": {
    chrome: {
      lookupLabel: "Look something up, eh",
    },
  },
} as const;

/**
 * Builds an isolated i18next runtime for one request/tab. `initImmediate:
 * false` makes init synchronous so server rendering sees translated copy on
 * the first pass.
 */
export const createCopyRuntime = (language: string) => {
  const runtime = createInstance();
  void runtime.use(initReactI18next).init({
    lng: language,
    fallbackLng: "en-US",
    defaultNS: "chrome",
    resources: copyByLanguage,
    initImmediate: false,
    interpolation: { escapeValue: false },
  });
  return runtime;
};
