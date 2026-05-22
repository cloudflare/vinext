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
import * as ReactDOM from "react-dom";
import { hasAppNavigationRuntimeBootstrap } from "../client/navigation-runtime.js";
import { escapeInlineContent } from "./head.js";
import { useScriptNonce } from "./script-nonce-context.js";
import {
  useBeforeInteractiveRegister,
  type BeforeInteractiveInlineScript,
} from "./before-interactive-context.js";

export type ScriptProps = {
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
};

// Track scripts that have already been loaded, plus remote scripts currently
// loading, to avoid duplicate DOM insertion when same-src components mount
// before the first load event fires.
const loadedScripts = new Set<string>();
const loadingScripts = new Map<string, Promise<Event>>();

function getClientAutoNonce(): string | undefined {
  if (typeof document === "undefined") return undefined;

  const existingNonceElement = document.querySelector("[nonce]");
  if (!(existingNonceElement instanceof HTMLElement)) {
    return undefined;
  }

  return existingNonceElement.nonce || existingNonceElement.getAttribute("nonce") || undefined;
}

function resolveScriptNonce(explicitNonce: unknown, contextualNonce?: string): string | undefined {
  if (typeof explicitNonce === "string" && explicitNonce.length > 0) {
    return explicitNonce;
  }

  if (typeof window === "undefined") {
    return contextualNonce;
  }

  return getClientAutoNonce();
}

function buildBeforeInteractiveScriptProps(options: {
  src?: string;
  id?: string;
  rest: Record<string, unknown>;
  resolvedNonce?: string;
  dangerouslySetInnerHTML?: { __html: string };
}): Record<string, unknown> {
  const scriptProps: Record<string, unknown> = { ...options.rest };
  if (options.src) scriptProps.src = options.src;
  if (options.id) scriptProps.id = options.id;
  if (options.resolvedNonce) {
    scriptProps.nonce = options.resolvedNonce;
  }
  if (options.dangerouslySetInnerHTML) {
    scriptProps.dangerouslySetInnerHTML = {
      __html: escapeInlineContent(options.dangerouslySetInnerHTML.__html, "script"),
    };
  }
  return scriptProps;
}

/**
 * Extract the inline script content for a `beforeInteractive` Script element
 * with no `src`. Returns `null` when the element has neither a string-shaped
 * `children` value nor a valid `dangerouslySetInnerHTML.__html` payload — in
 * that case the caller should fall through to React's regular rendering path.
 *
 * The returned string is the raw author-supplied JavaScript content. Callers
 * are responsible for passing it through `escapeInlineContent(..., "script")`
 * before emitting it inside a `<script>` tag (we keep that escape adjacent
 * to the emit point so the rule is obvious at the boundary).
 */
function extractBeforeInteractiveInlineContent(
  children: React.ReactNode,
  dangerouslySetInnerHTML?: { __html: string },
): string | null {
  if (
    dangerouslySetInnerHTML &&
    typeof dangerouslySetInnerHTML.__html === "string" &&
    dangerouslySetInnerHTML.__html.length > 0
  ) {
    return dangerouslySetInnerHTML.__html;
  }
  if (typeof children === "string" && children.length > 0) {
    return children;
  }
  if (Array.isArray(children) && children.every((c) => typeof c === "string")) {
    const joined = (children as string[]).join("");
    return joined.length > 0 ? joined : null;
  }
  return null;
}

/**
 * Convert the residual `<Script>` props into a plain string-attributes record
 * for emission inside a hoisted `<script>` tag. Drops React-only props
 * (event handlers, children, etc.) and reserved keys already handled by the
 * pre-head-injection emitter (id, nonce). Skips `undefined`/`null` so they
 * round-trip as "attribute absent" rather than `attr="undefined"`.
 */
function collectBeforeInteractiveAttributes(
  rest: Record<string, unknown>,
): Record<string, string | boolean> {
  const RESERVED = new Set([
    "id",
    "nonce",
    "src",
    "children",
    "strategy",
    "dangerouslySetInnerHTML",
    "onLoad",
    "onReady",
    "onError",
  ]);
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (RESERVED.has(key)) continue;
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === "boolean") {
      out[key] = true;
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      out[key] = String(value);
      continue;
    }
    // Skip anything else (functions, objects) — they cannot serialise into an
    // HTML attribute and only the developer-controlled string/boolean shape
    // is expected for native `<script>` attributes here.
  }
  return out;
}

function setBooleanScriptAttribute(el: HTMLScriptElement, attr: string, value: unknown): boolean {
  const enabled = value !== false && value !== "false" && Boolean(value);

  switch (attr) {
    case "async":
      el.async = enabled;
      break;
    case "defer":
      el.defer = enabled;
      break;
    case "noModule":
    case "nomodule":
      el.noModule = enabled;
      break;
    default:
      return false;
  }

  if (!enabled) {
    // Dynamic script elements start in the browser's force-async state.
    // Setting and removing the attribute mirrors Next.js and clears that state.
    el.setAttribute(attr, "");
    el.removeAttribute(attr);
  }

  return true;
}

function setScriptAttributes(el: HTMLScriptElement, rest: Record<string, unknown>): void {
  for (const [attr, value] of Object.entries(rest)) {
    if (attr === "dangerouslySetInnerHTML") continue;
    if (value === undefined) continue;
    if (setBooleanScriptAttribute(el, attr, value)) continue;
    if (attr === "className" && typeof value === "string") {
      el.setAttribute("class", value);
    } else if (typeof value === "string") {
      el.setAttribute(attr, value);
    } else if (typeof value === "boolean" && value) {
      el.setAttribute(attr, "");
    }
  }
}

function loadClientScript(
  props: ScriptProps,
  options: {
    resolvedNonce?: string;
    fireReadyWhenAlreadyLoaded: boolean;
  },
): void {
  const {
    src,
    id,
    onLoad,
    onReady,
    onError,
    strategy = "afterInteractive",
    children,
    dangerouslySetInnerHTML,
    ...rest
  } = props;
  if (typeof window === "undefined") return;

  const key = id ?? src ?? "";
  if (key && loadedScripts.has(key)) {
    if (options.fireReadyWhenAlreadyLoaded) {
      onReady?.();
    }
    return;
  }

  if (src) {
    const existingLoad = loadingScripts.get(src);
    if (existingLoad) {
      void existingLoad.then(
        (event) => {
          if (key) loadedScripts.add(key);
          onLoad?.(event);
          onReady?.();
        },
        (event) => onError?.(event),
      );
      return;
    }
  }

  const el = document.createElement("script");
  if (src) el.src = src;
  if (id) el.id = id;

  setScriptAttributes(el, rest);
  if (options.resolvedNonce && !el.getAttribute("nonce")) {
    el.setAttribute("nonce", options.resolvedNonce);
  }

  if (strategy === "worker") {
    el.setAttribute("type", "text/partytown");
  }

  const markLoaded = () => {
    if (key) loadedScripts.add(key);
    onReady?.();
  };

  if (dangerouslySetInnerHTML?.__html) {
    // Intentional: mirrors the Next.js <Script> API where dangerouslySetInnerHTML
    // is developer-supplied inline script content (not user input). The prop name
    // itself signals developer awareness of the XSS risk, consistent with React's
    // design. User-supplied data must never flow into this prop.
    el.innerHTML = dangerouslySetInnerHTML.__html;
    markLoaded();
  } else if (children && typeof children === "string") {
    el.textContent = children;
    markLoaded();
  } else if (src) {
    const loadPromise = new Promise<Event>((resolve, reject) => {
      el.addEventListener("load", (event) => {
        resolve(event);
        if (key) loadedScripts.add(key);
        onLoad?.(event);
        onReady?.();
      });
      el.addEventListener("error", (event) => {
        reject(event);
        onError?.(event);
      });
    });
    loadPromise.catch(() => undefined).finally(() => loadingScripts.delete(src));
    loadingScripts.set(src, loadPromise);
  }

  document.body.appendChild(el);
}

/**
 * Load a script imperatively (outside of React).
 */
export function handleClientScriptLoad(props: ScriptProps): void {
  loadClientScript(props, {
    resolvedNonce: resolveScriptNonce(props.nonce),
    fireReadyWhenAlreadyLoaded: false,
  });
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
  const key = id ?? src ?? "";
  const contextualNonce = useScriptNonce();
  const resolvedNonce = resolveScriptNonce(rest.nonce, contextualNonce);
  // Available only during SSR — the provider lives in app-ssr-entry.ts. When
  // missing (Pages Router SSR, raw renderToString, client render) we keep the
  // inline `<script>` element in source order.
  const registerBeforeInteractive = useBeforeInteractiveRegister();

  // Client path: load scripts via useEffect based on strategy.
  // useEffect never runs during SSR, so it's safe to call unconditionally.
  useEffect(() => {
    if (hasMounted.current) return;
    hasMounted.current = true;

    if (strategy === "beforeInteractive") {
      return;
    }

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

      loadClientScript(
        {
          src,
          id,
          strategy,
          onLoad,
          onReady,
          onError,
          children,
          dangerouslySetInnerHTML,
          ...rest,
        },
        { resolvedNonce, fireReadyWhenAlreadyLoaded: true },
      );
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
  }, [
    src,
    id,
    strategy,
    onLoad,
    onReady,
    onError,
    children,
    dangerouslySetInnerHTML,
    key,
    resolvedNonce,
    rest,
  ]);

  // SSR path: only "beforeInteractive" renders a <script> tag server-side
  if (typeof window === "undefined") {
    // React Float preload — emits <link rel="preload" as="script" /> in <head>
    // so the script is fetched while HTML streams. Mirrors Next.js's App Router
    // behavior at .nextjs-ref/packages/next/src/client/script.tsx:298-376:
    //   - afterInteractive with src: preload only (no <script> tag in SSR)
    //   - beforeInteractive with src: preload + <script> tag
    //   - inline scripts (no src): no preload
    // Calling ReactDOM.preload during SSR is safe in both routers; React only
    // hoists the link when it has a real <head> to hoist into.
    if (
      src &&
      typeof ReactDOM.preload === "function" &&
      (strategy === "afterInteractive" || strategy === "beforeInteractive")
    ) {
      const integrity = typeof rest.integrity === "string" ? rest.integrity : undefined;
      const crossOrigin =
        rest.crossOrigin === "anonymous" || rest.crossOrigin === "use-credentials"
          ? rest.crossOrigin
          : undefined;
      const preloadOptions: ReactDOM.PreloadOptions = {
        as: "script",
        crossOrigin,
      };
      if (resolvedNonce !== undefined) {
        preloadOptions.nonce = resolvedNonce;
      }
      if (integrity !== undefined) {
        preloadOptions.integrity = integrity;
      }
      ReactDOM.preload(src, preloadOptions);
    }

    if (strategy === "beforeInteractive") {
      // Inline beforeInteractive scripts (no src) need to run BEFORE any
      // stylesheets, modulepreload links, or other resource hints React Float
      // hoists into <head>. React Fizz emits user-rendered head children
      // AFTER the hoisted resources, so leaving the script in source order
      // breaks the no-flash dark-mode pattern. We instead capture the inline
      // content through BeforeInteractiveContext and the SSR pipeline emits
      // it immediately after `<head>` opens — guaranteeing it precedes every
      // React-emitted hint in the streamed HTML.
      const inlineContent = src
        ? null
        : extractBeforeInteractiveInlineContent(children, dangerouslySetInnerHTML);
      if (inlineContent !== null && registerBeforeInteractive) {
        const inline: BeforeInteractiveInlineScript = {
          id,
          // Escape `</script>` sequences exactly as the inline render path does
          // (see buildBeforeInteractiveScriptProps); keep the escape colocated
          // with the emit boundary so it never gets accidentally skipped.
          innerHTML: escapeInlineContent(inlineContent, "script"),
          nonce: resolvedNonce,
          attributes: collectBeforeInteractiveAttributes(rest),
        };
        registerBeforeInteractive(inline);
        return null;
      }

      return React.createElement(
        "script",
        buildBeforeInteractiveScriptProps({
          src,
          id,
          rest,
          resolvedNonce,
          dangerouslySetInnerHTML,
        }),
        children,
      );
    }
    // Other strategies don't render during SSR
    return null;
  }

  if (strategy === "beforeInteractive") {
    // On the client, only suppress the `<script>` render for inline
    // beforeInteractive Scripts in App Router pages. The pre-head splice
    // in app-ssr-entry/app-ssr-stream already put the tag in the DOM, so
    // rendering it again would either duplicate the script (for Scripts
    // outside `<head>`) or cause a hydration mismatch (positions differ).
    //
    // For Pages Router and any other SSR path that didn't run through
    // app-ssr-entry, the server rendered the `<script>` inline in source
    // order, so the client must match. We detect "App Router" via the
    // navigation runtime that the App Router bootstrap installs before
    // calling hydrateRoot — it is the most reliable runtime signal we
    // can read from inside a `"use client"` shim.
    //
    // External-`src` beforeInteractive scripts always keep rendering
    // inline. They are not captured by the pre-head splice and must mount
    // through React so their `src` attribute is fetched on the client.
    const inlineContent = src
      ? null
      : extractBeforeInteractiveInlineContent(children, dangerouslySetInnerHTML);
    if (inlineContent !== null && hasAppNavigationRuntimeBootstrap()) {
      return null;
    }

    return React.createElement(
      "script",
      buildBeforeInteractiveScriptProps({
        src,
        id,
        rest,
        resolvedNonce,
        dangerouslySetInnerHTML,
      }),
      children,
    );
  }

  // The component itself renders nothing — scripts are injected imperatively
  return null;
}

export default Script;
