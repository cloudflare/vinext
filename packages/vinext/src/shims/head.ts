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
      attrs.push(`${key}="${escapeAttr(value)}"`);
    } else if (typeof value === "boolean" && value) {
      if (!isSafeAttrName(key)) continue;
      attrs.push(key);
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
      domEl.setAttribute(key, "");
    } else if (typeof value === "string") {
      if (!isSafeAttrName(key)) continue;
      domEl.setAttribute(key, value);
    }
  }
}

/**
 * When a `nonce` is present on an element, browsers such as Chrome and Firefox
 * strip it out of the actual HTML attributes for security reasons *when the
 * element is added to the document*. Thus, two equivalent elements that have
 * nonces will compare as unequal with `Element.isEqualNode()` once one has
 * been added to the document. Although the `element.nonce` property will be
 * the same for both elements, the one that was added to the document will
 * return an empty string for its nonce HTML attribute value.
 *
 * This helper therefore strips the nonce value from `newTag` (preserving the
 * typed `.nonce` property) before comparing it to `oldTag`. Mirrors Next.js's
 * head-manager isEqualNode:
 * .nextjs-ref/packages/next/src/client/head-manager.ts
 *
 * See: https://bugs.chromium.org/p/chromium/issues/detail?id=1211471#c12
 */
export function isEqualHeadNode(oldTag: Element, newTag: Element): boolean {
  if (
    typeof HTMLElement !== "undefined" &&
    oldTag instanceof HTMLElement &&
    newTag instanceof HTMLElement
  ) {
    const nonce = newTag.getAttribute("nonce");
    // Only strip the nonce if `oldTag` has had it stripped. An element's nonce
    // attribute is only stripped by the browser when a CSP nonce policy is
    // active; otherwise the attribute remains and the values compare normally.
    if (nonce && !oldTag.getAttribute("nonce")) {
      const cloneTag = newTag.cloneNode(true) as HTMLElement;
      cloneTag.setAttribute("nonce", "");
      cloneTag.nonce = nonce;
      return nonce === oldTag.nonce && oldTag.isEqualNode(cloneTag);
    }
  }
  return oldTag.isEqualNode(newTag);
}

/**
 * Minimal `Document` surface required by the head reconciler. Exported (as a
 * type) so tests can build a focused DOM double without dragging in a full
 * `Document` polyfill.
 */
export type HeadDocumentLike = {
  head: HeadEl | null;
  createElement(tag: string): Element;
};
type HeadEl = {
  querySelectorAll(selector: string): ArrayLike<Element>;
  appendChild(el: Element): unknown;
};

/**
 * Reconcile `desired` head elements against existing `[data-next-head]` tags
 * inside `doc.head`. Mirrors Next.js's head-manager
 * (`.nextjs-ref/packages/next/src/client/head-manager.ts`): instead of
 * purging every managed element and recreating it (which would re-execute
 * `<script>` tags and re-fetch `<link>` resources on every render), we diff
 * desired against existing per tag type and only touch the DOM for the diff.
 *
 * Extracted from `syncClientHead` so tests can drive it with a DOM double
 * without setting global `document`.
 *
 * @internal exported for tests only.
 */
export function _reconcileClientHead(
  doc: HeadDocumentLike,
  desired: readonly React.ReactElement[],
): void {
  const headEl = doc.head;
  if (!headEl) return;

  // Bucket desired elements by tag type so we diff each bucket independently.
  // Matches Next.js's per-type reconciliation; `data-next-head` is scoped per
  // tag, and a desired `<meta>` should never accidentally match an existing
  // `<link>` even if their attribute shapes overlap.
  const desiredByType = new Map<string, React.ReactElement[]>();
  for (const child of desired) {
    if (typeof child.type !== "string") continue;
    let list = desiredByType.get(child.type);
    if (!list) {
      list = [];
      desiredByType.set(child.type, list);
    }
    list.push(child);
  }

  // Snapshot existing managed elements once. We will mutate the per-type sets
  // as we match new tags to old ones; anything left over is genuinely stale
  // and must be removed.
  const existingByType = new Map<string, Set<Element>>();
  const managed = headEl.querySelectorAll("[data-next-head]");
  for (let i = 0; i < managed.length; i++) {
    const el = managed[i];
    if (!el) continue;
    const tag = el.tagName.toLowerCase();
    let bucket = existingByType.get(tag);
    if (!bucket) {
      bucket = new Set();
      existingByType.set(tag, bucket);
    }
    bucket.add(el);
  }

  const tagTypes = new Set<string>([...desiredByType.keys(), ...existingByType.keys()]);
  for (const tagType of tagTypes) {
    const desiredForType = desiredByType.get(tagType) ?? [];
    const oldTags = existingByType.get(tagType) ?? new Set<Element>();
    const toAppend: Element[] = [];

    for (const component of desiredForType) {
      const newTag = doc.createElement(tagType);
      _applyHeadPropsToElement(newTag, component.props as Record<string, unknown>);
      newTag.setAttribute("data-next-head", "");

      let matched = false;
      for (const oldTag of oldTags) {
        if (isEqualHeadNode(oldTag, newTag)) {
          oldTags.delete(oldTag);
          matched = true;
          break;
        }
      }
      if (!matched) toAppend.push(newTag);
    }

    for (const oldTag of oldTags) {
      oldTag.parentNode?.removeChild(oldTag);
    }
    for (const newTag of toAppend) {
      headEl.appendChild(newTag);
    }
  }
}

/**
 * Synchronise the client `<head>` with the reduced projection of all mounted
 * `<Head>` instances. Thin wrapper around `_reconcileClientHead` that pulls
 * the desired set from the live `_clientHeadChildren` map and dispatches to
 * the global `document`.
 */
function syncClientHead(): void {
  _reconcileClientHead(
    document as unknown as HeadDocumentLike,
    reduceHeadChildren([..._clientHeadChildren.values()]),
  );
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
