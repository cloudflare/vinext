import { htmlTokenListContains } from "./html.js";

type InlineCssStylesheetLinkElement = Pick<HTMLLinkElement, "getAttribute" | "hasAttribute">;

const GLOBAL_CSS_OWNER_ASSET = "/app-global-css-";
const GLOBAL_CSS_OWNER_DEDUPE = Symbol.for("vinext.globalCssOwnerDedupe");

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

function dedupeGlobalCssOwnerStylesheetLinks(): void {
  const owners = new Map<string, HTMLLinkElement>();
  const links = document.head.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet'][href]");

  for (const link of links) {
    let href: string;
    try {
      href = new URL(link.getAttribute("href") ?? "", window.location.href).href;
    } catch {
      continue;
    }
    if (!href.includes(GLOBAL_CSS_OWNER_ASSET)) continue;

    const previous = owners.get(href);
    if (!previous) {
      owners.set(href, link);
      continue;
    }

    const previousIsManaged = previous.hasAttribute("data-precedence");
    const currentIsManaged = link.hasAttribute("data-precedence");
    if (currentIsManaged && !previousIsManaged) {
      previous.remove();
      owners.set(href, link);
    } else {
      link.remove();
    }
  }
}

/** Keep Vite's late dynamic CSS loader from duplicating an RSC global owner. */
export function installGlobalCssOwnerStylesheetDedupe(): void {
  if (Reflect.get(globalThis, GLOBAL_CSS_OWNER_DEDUPE)) return;

  dedupeGlobalCssOwnerStylesheetLinks();
  const observer = new MutationObserver(dedupeGlobalCssOwnerStylesheetLinks);
  observer.observe(document.head, { childList: true });
  Reflect.set(globalThis, GLOBAL_CSS_OWNER_DEDUPE, observer);
}
