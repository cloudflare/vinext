/**
 * Loads App Router client references in production builds from the chunks
 * their Flight rows name, as React's webpack binding does in Next.js. The
 * browser entry names none of those chunks, so its hash doesn't change when a
 * client reference is added or changes.
 *
 * React calls `__webpack_chunk_load__` for each chunk a reference's row names
 * (see server/app-client-reference-manifest.ts), and requires the reference
 * once they load. Its module chunk registers the reference as it evaluates
 * (see plugins/rsc-client-reference-loaders.ts). The other chunks load the way
 * Vite's preload helper loads a dynamic import's dependencies: JS chunks are
 * modulepreloaded, the module chunk evaluates once its stylesheets load, and
 * a failure dispatches `vite:preloadError`.
 */
import {
  CLIENT_REFERENCE_CHUNK_KIND,
  CLIENT_REFERENCE_CHUNK_URL_SEPARATOR,
} from "../../utils/client-reference-chunks.js";

type ClientReferenceExports = Record<string, unknown>;

const registered = new Map<string, ClientReferenceExports>();

export function registerClientReference(key: string, exports: ClientReferenceExports): void {
  registered.set(key, exports);
}

/** What @vitejs/plugin-rsc/browser calls as `clientReferences.default[key]()`. */
export const clientReferences: Record<string, () => Promise<ClientReferenceExports>> = new Proxy(
  {},
  {
    get(_target, key) {
      // Not a thenable. Reference keys are hashes, so none is named "then".
      if (typeof key !== "string" || key === "then") return undefined;
      return async () => {
        const exports = registered.get(key);
        if (!exports) throw new Error(`client reference not found '${key}'`);
        return exports;
      };
    },
  },
);

// A link with each resolved href in the document, and a stylesheet with each.
// Reading every link's href for each chunk would make loading N chunks cost
// N * N reads, as the server-rendered head modulepreloads each chunk. A cached
// link only answers while it is still in the document with that href (and
// rel), and any other check rescans, so links React or the app adds, removes
// or changes are seen as an exact scan sees them.
let linksByHref = new Map<string, HTMLLinkElement>();
let stylesheetsByHref = new Map<string, HTMLLinkElement>();

function isLinked(href: string, stylesheet: boolean): boolean {
  const cached = (stylesheet ? stylesheetsByHref : linksByHref).get(href);
  if (cached?.isConnected && cached.href === href && (!stylesheet || cached.rel === "stylesheet")) {
    return true;
  }
  linksByHref = new Map();
  stylesheetsByHref = new Map();
  for (const link of document.getElementsByTagName("link")) {
    const linkHref = link.href;
    linksByHref.set(linkHref, link);
    if (link.rel === "stylesheet") stylesheetsByHref.set(linkHref, link);
  }
  return (stylesheet ? stylesheetsByHref : linksByHref).has(href);
}

function appendLink(url: string, stylesheet: boolean): HTMLLinkElement | null {
  const href = new URL(url, document.baseURI).href;
  if (isLinked(href, stylesheet)) return null;
  const link = document.createElement("link");
  link.rel = stylesheet ? "stylesheet" : "modulepreload";
  if (!stylesheet) link.as = "script";
  link.crossOrigin = "";
  link.href = href;
  const nonceMeta = document.querySelector<HTMLMetaElement>("meta[property=csp-nonce]");
  const nonce = nonceMeta?.nonce || nonceMeta?.getAttribute("nonce");
  if (nonce) link.setAttribute("nonce", nonce);
  document.head.appendChild(link);
  linksByHref.set(href, link);
  if (stylesheet) stylesheetsByHref.set(href, link);
  return link;
}

const stylesheets = new Map<string, Promise<void>>();

/**
 * Resolves once the stylesheet loads or fails. React keeps a failed chunk's
 * promise for the rest of the session, so rejecting would fail every client
 * reference that shares the stylesheet, even once the network recovers. As in
 * Next.js, a reference renders without a stylesheet that fails to load, and
 * `vite:preloadError` still lets the app reload the page.
 */
function loadStylesheet(url: string): Promise<void> {
  const href = new URL(url, document.baseURI).href;
  let loaded = stylesheets.get(href);
  if (loaded) return loaded;
  const link = appendLink(url, true);
  loaded = link
    ? new Promise<void>((resolve) => {
        link.addEventListener("load", () => resolve());
        link.addEventListener("error", () => {
          const event: Event & { payload?: unknown } = new Event("vite:preloadError", {
            cancelable: true,
          });
          event.payload = new Error(`Unable to preload CSS for ${url}`);
          window.dispatchEvent(event);
          resolve();
        });
      })
    : Promise.resolve();
  stylesheets.set(href, loaded);
  return loaded;
}

function loadChunk(chunkId: string): Promise<unknown> {
  const url = chunkId.slice(1);
  switch (chunkId[0]) {
    case CLIENT_REFERENCE_CHUNK_KIND.module: {
      const [file, ...css] = url.split(CLIENT_REFERENCE_CHUNK_URL_SEPARATOR);
      // As in Vite's preload helper, the chunk evaluates once its stylesheets
      // load. Vite wraps this import in that helper, which dispatches
      // vite:preloadError when it fails.
      return Promise.all(css.map(loadStylesheet)).then(() => import(/* @vite-ignore */ file!));
    }
    case CLIENT_REFERENCE_CHUNK_KIND.preload:
      appendLink(url, false);
      return Promise.resolve();
    default:
      return Promise.reject(new Error(`[vinext] Unknown client reference chunk '${chunkId}'`));
  }
}

(globalThis as { __webpack_chunk_load__?: (chunkId: string) => Promise<unknown> })[
  "__webpack_chunk_load__"
] = loadChunk;
