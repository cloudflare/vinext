import type React from "react";

export type ScriptProps = {
  src?: string;
  strategy?:
    | "beforeInteractive"
    | "beforePageRender"
    | "afterInteractive"
    | "lazyOnload"
    | "worker";
  id?: string;
  onLoad?: (event: Event) => void;
  onReady?: () => void;
  onError?: (event: Event) => void;
  children?: React.ReactNode;
  dangerouslySetInnerHTML?: { __html: string };
  type?: string;
  async?: boolean;
  defer?: boolean;
  crossOrigin?: string;
  nonce?: string;
  integrity?: string;
  stylesheets?: string[];
  [key: string]: unknown;
};

export const loadedScripts = new Set<string>();
export const scriptCache = new Map<string, Promise<void>>();
const loadedStylesheets = new WeakMap<object, Set<string>>();

function getClientAutoNonce(): string | undefined {
  if (typeof document === "undefined") return undefined;

  const existingNonceElement = document.querySelector("[nonce]");
  if (!existingNonceElement) return undefined;

  if (typeof HTMLElement !== "undefined" && existingNonceElement instanceof HTMLElement) {
    return existingNonceElement.nonce || existingNonceElement.getAttribute("nonce") || undefined;
  }

  return existingNonceElement.getAttribute("nonce") || undefined;
}

export function resolveScriptNonce(
  explicitNonce: unknown,
  contextualNonce?: string,
): string | undefined {
  if (typeof explicitNonce === "string" && explicitNonce.length > 0) {
    return explicitNonce;
  }

  if (typeof contextualNonce === "string" && contextualNonce.length > 0) {
    return contextualNonce;
  }

  if (typeof window === "undefined") {
    return undefined;
  }

  return getClientAutoNonce();
}

function insertClientStylesheets(stylesheets: string[] | undefined): void {
  if (!stylesheets || stylesheets.length === 0 || typeof document === "undefined") return;

  const head = document.head;
  if (!head) return;
  let documentStylesheets = loadedStylesheets.get(document);
  if (!documentStylesheets) {
    documentStylesheets = new Set<string>();
    for (const link of document.querySelectorAll?.('link[rel="stylesheet"][href]') ?? []) {
      const href = link.getAttribute("href");
      if (href) documentStylesheets.add(href);
    }
    loadedStylesheets.set(document, documentStylesheets);
  }

  for (const href of stylesheets) {
    if (documentStylesheets.has(href)) continue;
    documentStylesheets.add(href);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = href;
    head.appendChild(link);
  }
}

function setBooleanScriptAttribute(
  element: HTMLScriptElement,
  attribute: string,
  value: unknown,
): boolean {
  const enabled = value !== false && value !== "false" && Boolean(value);

  switch (attribute) {
    case "async":
      element.async = enabled;
      break;
    case "defer":
      element.defer = enabled;
      break;
    case "noModule":
    case "nomodule":
      element.noModule = enabled;
      break;
    default:
      return false;
  }

  if (!enabled) {
    element.setAttribute(attribute, "");
    element.removeAttribute(attribute);
  }

  return true;
}

export function setScriptAttributes(
  element: HTMLScriptElement,
  rest: Record<string, unknown>,
): void {
  for (const [attribute, value] of Object.entries(rest)) {
    if (attribute === "dangerouslySetInnerHTML" || attribute === "children" || value === undefined)
      continue;
    if (setBooleanScriptAttribute(element, attribute, value)) continue;
    if (attribute === "className" && typeof value === "string") {
      element.setAttribute("class", value);
    } else if (typeof value === "string" || typeof value === "number") {
      element.setAttribute(attribute, String(value));
    } else if (typeof value === "boolean" && value) {
      element.setAttribute(attribute, "");
    }
  }
}

export function loadClientScript(
  props: ScriptProps,
  options: {
    resolvedNonce?: string;
    fireReadyWhenAlreadyLoaded: boolean;
    insertStylesheets?: (stylesheets: string[] | undefined) => void;
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
    stylesheets,
    ...rest
  } = props;
  if (typeof window === "undefined") return;

  (options.insertStylesheets ?? insertClientStylesheets)(stylesheets);

  const key = id ?? src ?? "";
  if (key && loadedScripts.has(key)) {
    if (options.fireReadyWhenAlreadyLoaded) {
      onReady?.();
    }
    return;
  }

  if (src) {
    const existingLoad = scriptCache.get(src);
    if (existingLoad) {
      if (key) loadedScripts.add(key);
      void existingLoad.then(() => onLoad?.(undefined as unknown as Event), onError);
      return;
    }
  }

  const element = document.createElement("script");
  if (src) element.src = src;
  if (id) element.id = id;

  setScriptAttributes(element, rest);
  element.setAttribute("data-nscript", strategy);
  if (options.resolvedNonce && !element.getAttribute("nonce")) {
    element.setAttribute("nonce", options.resolvedNonce);
  }

  if (strategy === "worker") {
    element.setAttribute("type", "text/partytown");
  }

  const markLoaded = () => {
    if (key) loadedScripts.add(key);
    onReady?.();
  };

  if (dangerouslySetInnerHTML?.__html) {
    element.innerHTML = dangerouslySetInnerHTML.__html;
    markLoaded();
  } else if (children && typeof children === "string") {
    element.textContent = children;
    markLoaded();
  } else if (src) {
    const loadPromise = new Promise<void>((resolve, reject) => {
      element.addEventListener("load", (event) => {
        resolve();
        if (key) loadedScripts.add(key);
        onLoad?.(event);
        onReady?.();
      });
      element.addEventListener("error", (event) => {
        reject(event);
      });
    }).catch((event: Event) => {
      onError?.(event);
    });
    scriptCache.set(src, loadPromise);
  }

  document.body.appendChild(element);
}

export function handleClientScriptLoad(props: ScriptProps): void {
  if (props.strategy === "lazyOnload") {
    const load = () =>
      loadClientScript(props, {
        resolvedNonce: resolveScriptNonce(props.nonce),
        fireReadyWhenAlreadyLoaded: false,
      });
    const schedule = () => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(load);
      } else {
        setTimeout(load, 1);
      }
    };
    if (document.readyState === "complete") {
      schedule();
    } else {
      window.addEventListener("load", schedule);
    }
    return;
  }

  loadClientScript(props, {
    resolvedNonce: resolveScriptNonce(props.nonce),
    fireReadyWhenAlreadyLoaded: false,
  });
}

export function initScriptLoader(scripts: ScriptProps[]): void {
  for (const script of scripts) {
    handleClientScriptLoad(script);
  }

  for (const selector of [
    '[data-nscript="beforeInteractive"]',
    '[data-nscript="beforePageRender"]',
  ]) {
    for (const script of document.querySelectorAll(selector)) {
      const key = script.id || script.getAttribute("src");
      if (key) loadedScripts.add(key);
    }
  }
}
