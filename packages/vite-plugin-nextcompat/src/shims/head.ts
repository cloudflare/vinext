/**
 * next/head shim
 *
 * In the Pages Router, <Head> manages document <head> elements.
 * - On the server: collects elements into a module-level array that the
 *   dev-server reads after renderToString and injects into the HTML <head>.
 * - On the client: uses useEffect + DOM manipulation.
 */
import React, { useEffect, Children, isValidElement } from "react";

interface HeadProps {
  children?: React.ReactNode;
}

// --- SSR head collection ---

/** Collected head elements during SSR (reset before each render). */
let ssrHeadElements: string[] = [];

/** Reset the SSR head collector. Call before renderToString. */
export function resetSSRHead(): void {
  ssrHeadElements = [];
}

/** Get collected head HTML. Call after renderToString. */
export function getSSRHeadHTML(): string {
  return ssrHeadElements.join("\n  ");
}

/**
 * Convert a React element to an HTML string for SSR head injection.
 */
function reactElementToHTML(child: React.ReactElement): string {
  const tag = child.type as string;
  const props = child.props as Record<string, unknown>;
  const attrs: string[] = [];
  let innerHTML = "";

  for (const [key, value] of Object.entries(props)) {
    if (key === "children") {
      if (typeof value === "string") {
        innerHTML = value;
      }
    } else if (key === "dangerouslySetInnerHTML") {
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
    return `<${tag}${attrStr} data-nextcompat-head="true" />`;
  }

  return `<${tag}${attrStr} data-nextcompat-head="true">${innerHTML}</${tag}>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Component ---

function Head({ children }: HeadProps): null {
  // SSR path: collect elements for later injection
  if (typeof window === "undefined") {
    Children.forEach(children, (child) => {
      if (!isValidElement(child)) return;
      if (typeof child.type !== "string") return;
      ssrHeadElements.push(reactElementToHTML(child));
    });
    return null;
  }

  // Client path: useEffect DOM manipulation (runs after hydration)
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    const elements: Element[] = [];

    // Remove previous nextcompat-managed head elements
    document
      .querySelectorAll("[data-nextcompat-head]")
      .forEach((el) => el.remove());

    Children.forEach(children, (child) => {
      if (!isValidElement(child)) return;
      if (typeof child.type !== "string") return;

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

      domEl.setAttribute("data-nextcompat-head", "true");
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
