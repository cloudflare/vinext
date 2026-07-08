"use client";

/**
 * Preload links for rendered next/dynamic() boundaries.
 *
 * This MUST be a "use client" component. next/dynamic() can be called from
 * either a Server Component or a Client Component. If this rendered in the
 * environment of the call site, a Server-Component call site would render it in
 * the RSC environment, where the script-nonce React context is unavailable
 * (createContext is not callable in react-server), so emitted preload links
 * would drop the request CSP nonce — a CSP violation under
 * `script-src 'nonce-…' 'strict-dynamic'`.
 *
 * Marking it "use client" forces it into the SSR pass (where vinext installs
 * the ScriptNonceProvider via withScriptNonce()), so the nonce is available
 * regardless of whether the dynamic() call site is a Server or Client
 * Component. This mirrors Next.js's <PreloadChunks> ('use client') and vinext's
 * own next/script shim.
 *
 * Deliberate divergence from Next.js: for CSS we render
 * `<link rel="stylesheet">` WITHOUT `as="style"`. Next.js emits `as="style"`,
 * but per the HTML spec `as` is only meaningful on `rel="preload"`/`modulepreload`
 * — on `rel="stylesheet"` it is ignored by browsers and is semantically wrong.
 * React keys stylesheet resources on href + precedence, not `as`, so omitting it
 * is safe. This is an intentional, documented difference, not a parity bug.
 */
import React from "react";
import { getPagesClientAssets } from "vinext/server/pages-client-assets";
import * as ReactDOM from "react-dom";
import { useScriptNonce } from "./script-nonce-context.js";
import { appendAssetDeploymentIdQuery } from "../utils/deployment-id.js";

function dynamicPreloadHref(file: string): string {
  if (
    file.startsWith("/") ||
    file.startsWith("http://") ||
    file.startsWith("https://") ||
    file.startsWith("//")
  ) {
    return file;
  }
  return `/${file}`;
}

function resolveDynamicPreloadFiles(moduleIds: readonly string[] | undefined): string[] {
  if (!moduleIds || moduleIds.length === 0) return [];

  const preloadMap = getPagesClientAssets().dynamicPreloads;
  if (!preloadMap) return [];

  // NB: a missing key is NOT necessarily an error — a Server Component that
  // dynamically imports another Server Component has no client chunk and so is
  // legitimately absent from the map. We therefore can't reliably warn on a miss
  // at runtime without false positives; key-space integrity is instead guarded
  // by the realpath-normalising module-ID resolver (dynamic-preload-metadata.ts)
  // and the production round-trip tests.
  const files: string[] = [];
  const seen = new Set<string>();
  for (const moduleId of moduleIds) {
    for (const file of preloadMap[moduleId] ?? []) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }

  return files;
}

export function DynamicPreloadChunks(props: { moduleIds?: readonly string[] }) {
  const nonce = useScriptNonce();
  // Defensive guard matching Next.js's <PreloadChunks> `typeof window` check:
  // this component only does work during SSR. The runtime global is server-only
  // today (so on the client the map is absent/undefined and we already return
  // null), so this is belt-and-suspenders that also future-proofs against any
  // client-side leak of the preload map. Placed AFTER the (unconditional) hook
  // to keep hook order stable across renders.
  if (typeof window !== "undefined") return null;
  const files = resolveDynamicPreloadFiles(props.moduleIds);
  if (files.length === 0) return null;

  const stylesheets: React.ReactNode[] = [];
  for (const file of files) {
    const assetHref = dynamicPreloadHref(file);
    if (assetHref.endsWith(".css")) {
      const href = appendAssetDeploymentIdQuery(assetHref);
      stylesheets.push(
        React.createElement("link", {
          key: href,
          rel: "stylesheet",
          href,
          nonce,
          precedence: "dynamic",
        }),
      );
      continue;
    }

    if (assetHref.endsWith(".js") && typeof ReactDOM.preload === "function") {
      // Pass `nonce` directly (React omits the attribute when it is undefined),
      // matching the stylesheet branch above.
      const preloadOptions: ReactDOM.PreloadOptions = {
        as: "script",
        fetchPriority: "low",
        nonce,
      };
      ReactDOM.preload(assetHref, preloadOptions);
    }
  }

  return stylesheets.length > 0 ? React.createElement(React.Fragment, null, ...stylesheets) : null;
}
