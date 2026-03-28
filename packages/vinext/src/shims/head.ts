/**
 * next/head shim
 *
 * In the Pages Router, <Head> manages document <head> elements.
 * - On the server: collects elements into a module-level array that the
 *   dev-server reads after render and injects into the HTML <head>.
 * - On the client: reduces all mounted <Head> instances into one deduped
 *   document.head projection and applies it with DOM manipulation.
 */
import React, { useEffect, useRef, Children, isValidElement } from "react";

interface HeadProps {
  children?: React.ReactNode;
}

// --- SSR head collection ---
// State uses a registration pattern so this module can be bundled for the
// browser. The ALS-backed implementation lives in head-state.ts (server-only).

let _ssrHeadChildren: React.ReactNode[] = [];
const _clientHeadChildren = new Map<symbol, React.ReactNode>();

let _getSSRHeadChildren = (): React.ReactNode[] => _ssrHeadChildren;
let _resetSSRHeadImpl = (): void => {
  _ssrHeadChildren = [];
};

/**
 * Register ALS-backed state accessors. Called by head-state.ts on import.
 * @internal
 */
export function _registerHeadStateAccessors(accessors: {
  getSSRHeadChildren: () => React.ReactNode[];
  resetSSRHead: () => void;
}): void {
  _getSSRHeadChildren = accessors.getSSRHeadChildren;
  _resetSSRHeadImpl = accessors.resetSSRHead;
}

/** Reset the SSR head collector. Call before render. */
export function resetSSRHead(): void {
  _resetSSRHeadImpl();
}

/** Get collected head HTML. Call after render. */
export function getSSRHeadHTML(): string {
  return reduceHeadChildren(_getSSRHeadChildren())
    .map(reactElementToHTML)
    .filter(Boolean)
    .join("\n  ");
}

/**
 * Tags allowed inside <head>. Anything else is silently dropped.
 * This prevents injection of dangerous elements like <iframe>, <object>, etc.
 */
const ALLOWED_HEAD_TAGS = new Set(["title", "meta", "link", "style", "script", "base", "noscript"]);
const META_TYPES = ["name", "httpEquiv", "charSet", "itemProp"] as const;

function warnDisallowedHeadTag(tag: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[vinext] <Head> ignoring disallowed tag <${tag}>. ` +
        `Only ${[...ALLOWED_HEAD_TAGS].join(", ")} are allowed.`,
    );
  }
}

function collectHeadElements(
  list: React.ReactElement[],
  child: React.ReactNode,
): React.ReactElement[] {
  if (
    child == null ||
    typeof child === "boolean" ||
    typeof child === "string" ||
    typeof child === "number"
  ) {
    return list;
  }
  if (!isValidElement(child)) {
    return list;
  }
  if (child.type === React.Fragment) {
    return Children.toArray((child.props as { children?: React.ReactNode }).children).reduce(
      collectHeadElements,
      list,
    );
  }
  if (typeof child.type !== "string") {
    return list;
  }
  if (!ALLOWED_HEAD_TAGS.has(child.type)) {
    warnDisallowedHeadTag(child.type);
    return list;
  }
  return list.concat(child);
}

function normalizeHeadKey(key: React.Key | null): string | null {
  if (key == null || typeof key === "number") return null;
  const normalizedKey = String(key);
  const separatorIndex = normalizedKey.indexOf("$");
  return separatorIndex > 0 ? normalizedKey.slice(separatorIndex + 1) : null;
}

function createUniqueHeadFilter(): (child: React.ReactElement) => boolean {
  const keys = new Set<string>();
  const tags = new Set<string>();
  const metaTypes = new Set<string>();
  const metaCategories = new Map<string, Set<string>>();

  return (child) => {
    let isUnique = true;
    const normalizedKey = normalizeHeadKey(child.key);
    const hasKey = normalizedKey !== null;
    if (normalizedKey) {
      if (keys.has(normalizedKey)) {
        isUnique = false;
      } else {
        keys.add(normalizedKey);
      }
    }

    switch (child.type) {
      case "title":
      case "base":
        if (tags.has(child.type)) {
          isUnique = false;
        } else {
          tags.add(child.type);
        }
        break;
      case "meta": {
        const props = child.props as Record<string, unknown>;
        for (const metaType of META_TYPES) {
          if (!Object.prototype.hasOwnProperty.call(props, metaType)) continue;
          if (metaType === "charSet") {
            if (metaTypes.has(metaType)) {
              isUnique = false;
            } else {
              metaTypes.add(metaType);
            }
            continue;
          }

          const category = props[metaType];
          if (typeof category !== "string") continue;

          let categories = metaCategories.get(metaType);
          if (!categories) {
            categories = new Set<string>();
            metaCategories.set(metaType, categories);
          }

          if ((metaType !== "name" || !hasKey) && categories.has(category)) {
            isUnique = false;
          } else {
            categories.add(category);
          }
        }
        break;
      }
      default:
        break;
    }

    return isUnique;
  };
}

export function reduceHeadChildren(headChildren: React.ReactNode[]): React.ReactElement[] {
  return headChildren
    .reduce<React.ReactNode[]>((flattenedChildren, child) => {
      return flattenedChildren.concat(Children.toArray(child));
    }, [])
    .reduce(collectHeadElements, [])
    .reverse()
    .filter(createUniqueHeadFilter())
    .reverse();
}

/**
 * Validate an HTML attribute name. Rejects names that could break out of
 * the attribute context during SSR serialization, or that represent inline
 * event handlers (on*). Only allows alphanumeric characters, hyphens, and
 * common data-attribute patterns.
 */
const SAFE_ATTR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9\-:.]*$/;

export function isSafeAttrName(name: string): boolean {
  if (!SAFE_ATTR_NAME_RE.test(name)) return false;
  // Block inline event handlers (onclick, onerror, etc.)
  if (name.length > 2 && name[0] === "o" && name[1] === "n" && name[2] >= "A" && name[2] <= "z")
    return false;
  return true;
}

/**
 * Convert a React element to an HTML string for SSR head injection.
 * Returns an empty string for disallowed tag types.
 */
function reactElementToHTML(child: React.ReactElement): string {
  const tag = child.type as string;

  if (!ALLOWED_HEAD_TAGS.has(tag)) {
    warnDisallowedHeadTag(tag);
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
      if (!isSafeAttrName(key)) continue;
      attrs.push(`${key}="${escapeAttr(value)}"`);
    } else if (typeof value === "boolean" && value) {
      if (!isSafeAttrName(key)) continue;
      attrs.push(key);
    }
  }

  const attrStr = attrs.length ? " " + attrs.join(" ") : "";

  // Self-closing tags
  const selfClosing = ["meta", "link", "base"];
  if (selfClosing.includes(tag)) {
    return `<${tag}${attrStr} data-vinext-head="true" />`;
  }

  // For raw-content tags (script, style), escape closing-tag sequences so the
  // HTML parser doesn't prematurely terminate the element.
  const rawContentTags = ["script", "style"];
  if (rawContentTags.includes(tag) && innerHTML) {
    innerHTML = escapeInlineContent(innerHTML, tag);
  }

  return `<${tag}${attrStr} data-vinext-head="true">${innerHTML}</${tag}>`;
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape content that will be placed inside a raw <script> or <style> tag
 * during SSR. The HTML parser treats `</script>` (or `</style>`) as the end
 * of the block regardless of JavaScript string context, so any occurrence
 * of `</` followed by the tag name must be escaped.
 *
 * We replace `</script` and `</style` (case-insensitive) with `<\/script`
 * and `<\/style` respectively. The `<\/` form is harmless in JS/CSS string
 * context but prevents the HTML parser from seeing a closing tag.
 */
export function escapeInlineContent(content: string, tag: string): string {
  // Build a pattern like `<\/script` or `<\/style`, case-insensitive
  const pattern = new RegExp(`<\\/(${tag})`, "gi");
  return content.replace(pattern, "<\\/$1");
}

function syncClientHead(): void {
  document.querySelectorAll("[data-vinext-head]").forEach((el) => el.remove());

  for (const child of reduceHeadChildren([..._clientHeadChildren.values()])) {
    if (typeof child.type !== "string") continue;

    const domEl = document.createElement(child.type);
    const props = child.props as Record<string, unknown>;

    for (const [key, value] of Object.entries(props)) {
      if (key === "children" && typeof value === "string") {
        domEl.textContent = value;
      } else if (key === "dangerouslySetInnerHTML") {
        // skip for safety
      } else if (key === "className") {
        domEl.setAttribute("class", String(value));
      } else if (typeof value === "boolean" && value) {
        if (!isSafeAttrName(key)) continue;
        domEl.setAttribute(key, "");
      } else if (key !== "children" && typeof value === "string") {
        if (!isSafeAttrName(key)) continue;
        domEl.setAttribute(key, value);
      }
    }

    domEl.setAttribute("data-vinext-head", "true");
    document.head.appendChild(domEl);
  }
}

// --- Component ---

function Head({ children }: HeadProps): null {
  const headInstanceIdRef = useRef<symbol | null>(null);
  if (headInstanceIdRef.current === null) {
    headInstanceIdRef.current = Symbol("vinext-head");
  }

  // SSR path: collect elements for later injection
  if (typeof window === "undefined") {
    _getSSRHeadChildren().push(children);
    return null;
  }

  // Client path: update the shared head projection after hydration.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    const instanceId = headInstanceIdRef.current!;
    _clientHeadChildren.set(instanceId, children);
    syncClientHead();

    return () => {
      _clientHeadChildren.delete(instanceId);
      syncClientHead();
    };
  }, [children]);

  return null;
}

export default Head;
