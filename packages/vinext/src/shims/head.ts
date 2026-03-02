/**
 * next/head shim
 *
 * In the Pages Router, <Head> manages document <head> elements.
 * - On the server: collects elements into a module-level array that the
 *   dev-server reads after render and injects into the HTML <head>.
 * - On the client: uses useEffect + DOM manipulation.
 */
import React, { useEffect, Children, isValidElement } from "react";

interface HeadProps {
  children?: React.ReactNode;
}

// --- SSR head collection ---
// State uses a registration pattern so this module can be bundled for the
// browser. The ALS-backed implementation lives in head-state.ts (server-only).

let _ssrHeadElements: string[] = [];

let _getSSRHeadElements = (): string[] => _ssrHeadElements;
let _resetSSRHeadImpl = (): void => { _ssrHeadElements = []; };

/**
 * Register ALS-backed state accessors. Called by head-state.ts on import.
 * @internal
 */
export function _registerHeadStateAccessors(accessors: {
  getSSRHeadElements: () => string[];
  resetSSRHead: () => void;
}): void {
  _getSSRHeadElements = accessors.getSSRHeadElements;
  _resetSSRHeadImpl = accessors.resetSSRHead;
}

/** Reset the SSR head collector. Call before render. */
export function resetSSRHead(): void {
  _resetSSRHeadImpl();
}

/** Get collected head HTML. Call after render. */
export function getSSRHeadHTML(): string {
  return _getSSRHeadElements().join("\n  ");
}

/**
 * Tags allowed inside <head>. Anything else is silently dropped.
 * This prevents injection of dangerous elements like <iframe>, <object>, etc.
 */
const ALLOWED_HEAD_TAGS = new Set([
  "title", "meta", "link", "style", "script", "base", "noscript",
]);

/**
 * Convert a React element to an HTML string for SSR head injection.
 * Returns an empty string for disallowed tag types.
 */
function reactElementToHTML(child: React.ReactElement): string {
  const tag = child.type as string;

  if (!ALLOWED_HEAD_TAGS.has(tag)) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[vinext] <Head> ignoring disallowed tag <${tag}>. ` +
        `Only ${[...ALLOWED_HEAD_TAGS].join(", ")} are allowed.`,
      );
    }
    return "";
  }

  const props = child.props as Record<string, unknown>;
  const attrs: string[] = [];
  let innerHTML = "";

  for (const [key, value] of Object.entries(props)) {
    if (key === "children") {
      if (typeof value === "string") {
        innerHTML = escapeHTML(value);
      }
    } else if (key === "dangerouslySetInnerHTML") {
      // Intentionally raw — developer explicitly opted in.
      // SECURITY NOTE: This injects raw HTML during SSR. The client-side
      // path (line ~148) skips dangerouslySetInnerHTML for safety. Developers
      // must never pass unsanitized user input here — it is a stored XSS vector.
      const html = value as { __html: string };
      if (html?.__html) innerHTML = html.__html;
    } else if (key === "className") {
      attrs.push(`class="${escapeAttr(String(value))}"`);
    } else if (typeof value === "string") {
      attrs.push(`${key}="${escapeAttr(value)}"`);
    } else if (typeof value === "boolean" && value) {
      attrs.push(key);
    }
  }

  const attrStr = attrs.length ? " " + attrs.join(" ") : "";

  // Self-closing tags
  const selfClosing = ["meta", "link", "base"];
  if (selfClosing.includes(tag)) {
    return `<${tag}${attrStr} data-vinext-head="true" />`;
  }

  return `<${tag}${attrStr} data-vinext-head="true">${innerHTML}</${tag}>`;
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Component ---

function Head({ children }: HeadProps): null {
  // SSR path: collect elements for later injection
  if (typeof window === "undefined") {
    Children.forEach(children, (child) => {
      if (!isValidElement(child)) return;
      if (typeof child.type !== "string") return;
      const html = reactElementToHTML(child);
      if (html) _getSSRHeadElements().push(html);
    });
    return null;
  }

  // Client path: useEffect DOM manipulation (runs after hydration)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    const elements: Element[] = [];

    // Remove previous vinext-managed head elements
    document
      .querySelectorAll("[data-vinext-head]")
      .forEach((el) => el.remove());

    Children.forEach(children, (child) => {
      if (!isValidElement(child)) return;
      if (typeof child.type !== "string") return;
      if (!ALLOWED_HEAD_TAGS.has(child.type)) return;

      const domEl = document.createElement(child.type);
      const props = child.props as Record<string, unknown>;

      for (const [key, value] of Object.entries(props)) {
        if (key === "children" && typeof value === "string") {
          domEl.textContent = value;
        } else if (key === "dangerouslySetInnerHTML") {
          // skip for safety
        } else if (key === "className") {
          domEl.setAttribute("class", String(value));
        } else if (key !== "children" && typeof value === "string") {
          domEl.setAttribute(key, value);
        }
      }

      domEl.setAttribute("data-vinext-head", "true");
      document.head.appendChild(domEl);
      elements.push(domEl);
    });

    return () => {
      elements.forEach((el) => el.remove());
    };
  }, [children]);

  return null;
}

export default Head;
