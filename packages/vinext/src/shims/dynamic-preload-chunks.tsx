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
 */
import React from "react";
import * as ReactDOM from "react-dom";
import { useScriptNonce } from "./script-nonce-context.js";

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

  const preloadMap = globalThis.__VINEXT_DYNAMIC_PRELOADS__;
  if (!preloadMap) return [];

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
  const files = resolveDynamicPreloadFiles(props.moduleIds);
  if (files.length === 0) return null;

  const stylesheets: React.ReactNode[] = [];
  for (const file of files) {
    const href = dynamicPreloadHref(file);
    if (href.endsWith(".css")) {
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

    if (href.endsWith(".js") && typeof ReactDOM.preload === "function") {
      const preloadOptions: ReactDOM.PreloadOptions = {
        as: "script",
        fetchPriority: "low",
      };
      if (nonce !== undefined) {
        preloadOptions.nonce = nonce;
      }
      ReactDOM.preload(href, preloadOptions);
    }
  }

  return stylesheets.length > 0 ? React.createElement(React.Fragment, null, ...stylesheets) : null;
}
