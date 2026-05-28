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

type HeadProps = {
  children?: React.ReactNode;
};

// --- SSR head collection ---
// State uses a registration pattern so this module can be bundled for the
// browser. The ALS-backed implementation lives in head-state.ts (server-only).

let _ssrHeadChildren: React.ReactNode[] = [];
let _documentInitialHead: React.ReactNode[] = [];
const _clientHeadChildren = new Map<symbol, React.ReactNode>();

let _getSSRHeadChildren = (): React.ReactNode[] => _ssrHeadChildren;
let _resetSSRHeadImpl = (): void => {
  _ssrHeadChildren = [];
  _documentInitialHead = [];
};
let _getDocumentInitialHead = (): React.ReactNode[] => _documentInitialHead;
let _setDocumentInitialHead = (head: React.ReactNode[]): void => {
  _documentInitialHead = head;
};

/**
 * Register ALS-backed state accessors. Called by head-state.ts on import.
 * @internal
 */
export function _registerHeadStateAccessors(accessors: {
  getSSRHeadChildren: () => React.ReactNode[];
  resetSSRHead: () => void;
  getDocumentInitialHead?: () => React.ReactNode[];
  setDocumentInitialHead?: (head: React.ReactNode[]) => void;
}): void {
  _getSSRHeadChildren = accessors.getSSRHeadChildren;
  _resetSSRHeadImpl = accessors.resetSSRHead;
  if (accessors.getDocumentInitialHead) {
    _getDocumentInitialHead = accessors.getDocumentInitialHead;
  }
  if (accessors.setDocumentInitialHead) {
    _setDocumentInitialHead = accessors.setDocumentInitialHead;
  }
}

/** Reset the SSR head collector. Call before render. */
export function resetSSRHead(): void {
  _resetSSRHeadImpl();
}

/**
 * Register head tags returned by a user `_document.getInitialProps()` call.
 * Mirrors Next.js: `_document` may extend the head array passed to its render,
 * and those tags are merged into the final `<head>` output. We treat them the
 * same as `next/head` children — they go through the same dedupe pipeline so
 * later tags (by key or meta-type) win, matching Next.js semantics.
 *
 * Pass an empty array (or simply don't call this) to skip the merge.
 */
export function setDocumentInitialHead(head: React.ReactNode[]): void {
  _setDocumentInitialHead(head);
}

/**
 * Default head tags emitted alongside every Pages Router render — charset
 * first, then viewport. Mirrors Next.js's `defaultHead()` in
 * `packages/next/src/shared/lib/head.tsx`, which seeds the head array used
 * by `HeadManagerContext` before any user `<Head>` reduces over it.
 *
 * The canonical Next.js order is `<meta charset>` then `<meta viewport>`
 * then user tags, all with `data-next-head=""`. See assertion in
 * `test/e2e/next-head/index.test.ts`.
 */
function defaultHead(): React.ReactElement[] {
  return [
    React.createElement("meta", { charSet: "utf-8", key: "charset" }),
    React.createElement("meta", {
      name: "viewport",
      content: "width=device-width",
      key: "viewport",
    }),
  ];
}

/** Get collected head HTML. Call after render. */
export function getSSRHeadHTML(): string {
  // Order mirrors Next.js's `_document.tsx`: defaultHead seeds the head array,
  // user `next/head` tags reduce over it, and then `_document.getInitialProps`
  // may extend the array. The final `_document` render emits `{head}` (which
  // contains the defaults + user tags + initial-props tags) ahead of any
  // children declared inside `_document`'s own `<Head>`. Because the user
  // children inside `_document`'s `<Head>` are tracked via React tree render
  // (not next/head), they don't appear in this collector — so emitting
  // `defaultHead + user + initialProps` here matches Next.js's serialised
  // output up to that boundary.
  return reduceHeadChildren([
    ...defaultHead(),
    ..._getSSRHeadChildren(),
    ..._getDocumentInitialHead(),
  ])
    .map((child) => headChildToHTML(child.type as string, child.props as Record<string, unknown>))
    .filter(Boolean)
    .join("\n  ");
}

/**
 * Tags allowed inside <head>. Anything else is silently dropped.
 * This prevents injection of dangerous elements like <iframe>, <object>, etc.
 */
const ALLOWED_HEAD_TAGS = new Set(["title", "meta", "link", "style", "script", "base", "noscript"]);
const ALLOWED_HEAD_TAGS_LIST = Array.from(ALLOWED_HEAD_TAGS).join(", ");
const META_TYPES = ["name", "httpEquiv", "charSet", "itemProp"] as const;

/** Self-closing tags: no inner content, emit as <tag ... /> */
const SELF_CLOSING_HEAD_TAGS = new Set(["meta", "link", "base"]);

/** Tags whose content is raw text — closing-tag sequences must be escaped during SSR. */
const RAW_CONTENT_TAGS = new Set(["script", "style"]);

type HeadDOMElement = Pick<HTMLElement, "innerHTML" | "setAttribute" | "textContent">;

function warnDisallowedHeadTag(tag: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[vinext] <Head> ignoring disallowed tag <${tag}>. ` +
        `Only ${ALLOWED_HEAD_TAGS_LIST} are allowed.`,
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
    .reduce<React.ReactNode[]>(
      (flattenedChildren, child) => flattenedChildren.concat(Children.toArray(child)),
      [],
    )
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
 * Map React JSX attribute names to their HTML serialised form for the small
 * set of head-relevant attributes where the two differ. React's own renderer
 * normalises these automatically, but we serialise tags by hand so they reach
 * the final HTML in the canonical lowercase / kebab-case shape that browsers
 * (and Next.js's `test/e2e/next-head/index.test.ts`) expect.
 */
const JSX_TO_HTML_ATTR_MAP: Record<string, string> = {
  charSet: "charset",
  httpEquiv: "http-equiv",
  acceptCharset: "accept-charset",
  itemProp: "itemprop",
  itemType: "itemtype",
  itemID: "itemid",
  itemRef: "itemref",
  itemScope: "itemscope",
  crossOrigin: "crossorigin",
  referrerPolicy: "referrerpolicy",
};

function jsxAttrToHtml(name: string): string {
  return JSX_TO_HTML_ATTR_MAP[name] ?? name;
}

/**
 * Convert props + tag to an HTML string for SSR head injection.
 * Callers must only pass tags that have already been validated against
 * ALLOWED_HEAD_TAGS (e.g. via reduceHeadChildren / collectHeadElements).
 */
function headChildToHTML(tag: string, props: Record<string, unknown>): string {
  const attrs: string[] = [];
  let innerHTML = "";

  // dangerouslySetInnerHTML takes precedence over children, regardless of
  // prop iteration order. Check it first to match Next.js semantics.
  const rawHtml = getDangerouslySetInnerHTML(props.dangerouslySetInnerHTML);
  if (rawHtml != null) {
    // Intentionally raw — developer explicitly opted in.
    // SECURITY NOTE: This injects raw HTML. Developers must never pass
    // unsanitized user input here — it is a stored XSS vector.
    innerHTML = rawHtml;
  } else if (typeof props.children === "string") {
    innerHTML = escapeHTML(props.children);
  } else if (Array.isArray(props.children)) {
    innerHTML = escapeHTML(props.children.join(""));
  }

  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "dangerouslySetInnerHTML") {
      continue;
    } else if (key === "className") {
      attrs.push(`class="${escapeAttr(String(value))}"`);
    } else if (typeof value === "string") {
      if (!isSafeAttrName(key)) continue;
      attrs.push(`${jsxAttrToHtml(key)}="${escapeAttr(value)}"`);
    } else if (typeof value === "boolean" && value) {
      if (!isSafeAttrName(key)) continue;
      attrs.push(jsxAttrToHtml(key));
    }
  }

  const attrStr = attrs.length ? " " + attrs.join(" ") : "";

  if (SELF_CLOSING_HEAD_TAGS.has(tag)) {
    return `<${tag}${attrStr} data-next-head="" />`;
  }

  // For raw-content tags (script, style), escape closing-tag sequences so the
  // HTML parser doesn't prematurely terminate the element.
  if (RAW_CONTENT_TAGS.has(tag) && innerHTML) {
    innerHTML = escapeInlineContent(innerHTML, tag);
  }

  return `<${tag}${attrStr} data-next-head="">${innerHTML}</${tag}>`;
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
  // Build a pattern like `<\/script` or `<\/style`, case-insensitive.
  // `tag` is always a literal developer-controlled value ("script" or "style")
  // guarded by the RAW_CONTENT_TAGS.has(tag) check at all call sites — never user input.
  const pattern = new RegExp(`<\\/(${tag})`, "gi");
  return content.replace(pattern, "<\\/$1");
}

function getDangerouslySetInnerHTML(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const html = Reflect.get(value, "__html");
  return typeof html === "string" ? html : undefined;
}

export function _applyHeadPropsToElement(
  domEl: HeadDOMElement,
  props: Record<string, unknown>,
): void {
  const rawHtml = getDangerouslySetInnerHTML(props.dangerouslySetInnerHTML);

  if (rawHtml != null) {
    domEl.innerHTML = rawHtml;
  } else if (typeof props.children === "string") {
    domEl.textContent = props.children;
  } else if (Array.isArray(props.children)) {
    domEl.textContent = props.children.join("");
  }

  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "dangerouslySetInnerHTML") {
      continue;
    } else if (key === "className") {
      domEl.setAttribute("class", String(value));
    } else if (typeof value === "boolean" && value) {
      if (!isSafeAttrName(key)) continue;
      // Map JSX attribute names (charSet, httpEquiv, ...) to the HTML form
      // (charset, http-equiv, ...) so the client-side mutation matches the
      // SSR output. `setAttribute` is case-insensitive for HTML elements, so
      // `charSet` would land as `charset` by coincidence, but `httpEquiv`
      // would lowercase to `httpequiv` rather than `http-equiv` and produce
      // a hydration mismatch. The shared mapping in jsxAttrToHtml keeps both
      // paths in lockstep.
      domEl.setAttribute(jsxAttrToHtml(key), "");
    } else if (typeof value === "string") {
      if (!isSafeAttrName(key)) continue;
      domEl.setAttribute(jsxAttrToHtml(key), value);
    }
  }
}

function syncClientHead(): void {
  document.querySelectorAll("[data-next-head]").forEach((el) => el.remove());

  for (const child of reduceHeadChildren([..._clientHeadChildren.values()])) {
    if (typeof child.type !== "string") continue;

    const domEl = document.createElement(child.type);
    const props = child.props as Record<string, unknown>;
    _applyHeadPropsToElement(domEl, props);

    domEl.setAttribute("data-next-head", "");
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
  // oxlint-disable-next-line react-hooks/rules-of-hooks
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
