"use client";

/**
 * next/script shim
 *
 * Provides the <Script> component for loading third-party scripts with
 * configurable loading strategies.
 *
 * Strategies:
 *   - "beforeInteractive": rendered as a <script> tag in SSR output
 *   - "afterInteractive" (default): loaded client-side after hydration
 *   - "lazyOnload": deferred until window.load + requestIdleCallback
 *   - "worker": sets type="text/partytown" (requires Partytown setup)
 */
import React, { useEffect, useRef } from "react";

export interface ScriptProps {
  /** Script source URL */
  src?: string;
  /** Loading strategy. Default: "afterInteractive" */
  strategy?: "beforeInteractive" | "afterInteractive" | "lazyOnload" | "worker";
  /** Unique identifier for the script */
  id?: string;
  /** Called when the script has loaded */
  onLoad?: (e: Event) => void;
  /** Called when the script is ready (after load, and on every re-render if already loaded) */
  onReady?: () => void;
  /** Called on script load error */
  onError?: (e: Event) => void;
  /** Inline script content */
  children?: React.ReactNode;
  /** Dangerous inner HTML */
  dangerouslySetInnerHTML?: { __html: string };
  /** Script type attribute */
  type?: string;
  /** Async attribute */
  async?: boolean;
  /** Defer attribute */
  defer?: boolean;
  /** Crossorigin attribute */
  crossOrigin?: string;
  /** Nonce for CSP */
  nonce?: string;
  /** Integrity hash */
  integrity?: string;
  /** Additional attributes */
  [key: string]: unknown;
}

// Track scripts that have already been loaded to avoid duplicates
const loadedScripts = new Set<string>();

/**
 * Load a script imperatively (outside of React).
 */
export function handleClientScriptLoad(props: ScriptProps): void {
  const { src, id, onLoad, onError, strategy: _strategy, onReady: _onReady, children, ...rest } = props;
  if (typeof window === "undefined") return;

  const key = id ?? src ?? "";
  if (key && loadedScripts.has(key)) return;

  const el = document.createElement("script");
  if (src) el.src = src;
  if (id) el.id = id;

  for (const [attr, value] of Object.entries(rest)) {
    if (attr === "dangerouslySetInnerHTML" || attr === "className") continue;
    if (typeof value === "string") {
      el.setAttribute(attr, value);
    } else if (typeof value === "boolean" && value) {
      el.setAttribute(attr, "");
    }
  }

  if (children && typeof children === "string") {
    el.textContent = children;
  }

  if (onLoad) el.addEventListener("load", onLoad);
  if (onError) el.addEventListener("error", onError);

  document.body.appendChild(el);
  if (key) loadedScripts.add(key);
}

/**
 * Initialize multiple scripts at once (called during app bootstrap).
 */
export function initScriptLoader(scripts: ScriptProps[]): void {
  for (const script of scripts) {
    handleClientScriptLoad(script);
  }
}

function Script(props: ScriptProps): React.ReactElement | null {
  const {
    src,
    id,
    strategy = "afterInteractive",
    onLoad,
    onReady,
    onError,
    children,
    dangerouslySetInnerHTML,
    ...rest
  } = props;

  const hasMounted = useRef(false);

  // SSR path: only "beforeInteractive" renders a <script> tag server-side
  if (typeof window === "undefined") {
    if (strategy === "beforeInteractive") {
      const scriptProps: Record<string, unknown> = { ...rest };
      if (src) scriptProps.src = src;
      if (id) scriptProps.id = id;
      if (dangerouslySetInnerHTML) {
        scriptProps.dangerouslySetInnerHTML = dangerouslySetInnerHTML;
      }
      return React.createElement("script", scriptProps, children);
    }
    // Other strategies don't render during SSR
    return null;
  }

  const key = id ?? src ?? "";

  // Client path: load scripts via useEffect based on strategy
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (hasMounted.current) return;
    hasMounted.current = true;

    // Already loaded — just fire onReady
    if (key && loadedScripts.has(key)) {
      onReady?.();
      return;
    }

    const load = () => {
      if (key && loadedScripts.has(key)) {
        onReady?.();
        return;
      }

      const el = document.createElement("script");
      if (src) el.src = src;
      if (id) el.id = id;

      for (const [attr, value] of Object.entries(rest)) {
        if (attr === "className") {
          el.setAttribute("class", String(value));
        } else if (typeof value === "string") {
          el.setAttribute(attr, value);
        } else if (typeof value === "boolean" && value) {
          el.setAttribute(attr, "");
        }
      }

      if (strategy === "worker") {
        el.setAttribute("type", "text/partytown");
      }

      if (dangerouslySetInnerHTML?.__html) {
        el.innerHTML = dangerouslySetInnerHTML.__html as string;
      } else if (children && typeof children === "string") {
        el.textContent = children;
      }

      el.addEventListener("load", (e) => {
        if (key) loadedScripts.add(key);
        onLoad?.(e);
        onReady?.();
      });

      if (onError) {
        el.addEventListener("error", onError);
      }

      document.body.appendChild(el);
    };

    if (strategy === "lazyOnload") {
      // Wait for window load, then use idle callback
      if (document.readyState === "complete") {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(load);
        } else {
          setTimeout(load, 1);
        }
      } else {
        window.addEventListener("load", () => {
          if (typeof requestIdleCallback === "function") {
            requestIdleCallback(load);
          } else {
            setTimeout(load, 1);
          }
        });
      }
    } else {
      // "afterInteractive" (default), "beforeInteractive" (client re-mount), "worker"
      load();
    }
  }, [src, id, strategy, onLoad, onReady, onError, children, dangerouslySetInnerHTML, key, rest]);

  // The component itself renders nothing — scripts are injected imperatively
  return null;
}

export default Script;
