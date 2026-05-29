import { htmlTokenListContains } from "./html.js";

type InlineCssStylesheetLinkElement = Pick<HTMLLinkElement, "getAttribute" | "hasAttribute">;

function inlineStyleCoversStylesheetHref(styleHref: string, linkHref: string): boolean {
  for (const candidate of styleHref.split(/\s+/)) {
    if (candidate === linkHref) return true;
    try {
      const candidateUrl = new URL(candidate, window.location.href);
      const linkUrl = new URL(linkHref, window.location.href);
      if (candidateUrl.href === linkUrl.href) return true;
    } catch {
      // If either value is not parseable, exact string comparison above is the
      // only safe comparison.
    }
  }

  return false;
}

export function isInlineCssStylesheetLinkElement(link: InlineCssStylesheetLinkElement): boolean {
  return (
    htmlTokenListContains(link.getAttribute("rel"), "stylesheet") &&
    link.hasAttribute("href") &&
    (link.hasAttribute("data-precedence") || link.hasAttribute("precedence"))
  );
}

export function removeStylesheetLinksCoveredByInlineCss(): void {
  const inlineStyles = document.head.querySelectorAll<HTMLStyleElement>(
    "style[data-vinext-inline-css][data-href]",
  );
  if (inlineStyles.length === 0) return;

  const links = document.head.querySelectorAll<HTMLLinkElement>("link[rel][href]");
  for (const link of links) {
    if (!isInlineCssStylesheetLinkElement(link)) continue;

    const href = link.getAttribute("href");
    if (!href) continue;

    for (const style of inlineStyles) {
      const styleHref = style.getAttribute("data-href");
      if (styleHref && inlineStyleCoversStylesheetHref(styleHref, href)) {
        link.remove();
        break;
      }
    }
  }
}
