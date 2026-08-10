import Script from "next/script";

import { useRuntimeSettings } from "../../wiring/runtime-settings-context";

/**
 * Third-party tag-loader slot in the app shell. Sits *outside* the provider
 * pyramid (matching its historical position), so it takes the script URL as
 * a prop and only falls back to context when rendered inside the shell.
 * Only renders when configured, and loads after hydration.
 */
export const TagsScript = ({ src }: { src?: string }) => {
  const { tagsScriptUrl } = useRuntimeSettings();
  const resolved = src ?? tagsScriptUrl;

  if (!resolved) {
    return null;
  }

  return <Script id="atlas-tags" src={resolved} strategy="afterInteractive" />;
};
