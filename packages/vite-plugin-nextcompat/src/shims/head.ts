/**
 * next/head shim
 *
 * In the Pages Router, <Head> manages document <head> elements.
 * On the client, uses useEffect + DOM manipulation.
 * On the server, currently a no-op (TODO: SSR head collection).
 */
import React, { useEffect, Children, isValidElement } from "react";

interface HeadProps {
  children?: React.ReactNode;
}

function Head({ children }: HeadProps): null {
  useEffect(() => {
    if (typeof document === "undefined") return;

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
