/**
 * Nitro runtime plugin that lets vinext serve the files in `public/`.
 *
 * Nitro's static handler answers a request for a public file before any app
 * handler runs, so middleware would never see it. The plugin sends those
 * requests to vinext instead. vinext's router then decides which public file
 * a request resolves to, for example the destination of a rewrite, but only
 * the static handler can read the file from the server output. The plugin
 * publishes an asset fetcher that sends a request back through the Nitro app,
 * where the static handler answers it.
 *
 * This module runs in Nitro's server bundle, separate from vinext's request
 * handlers, so it imports nothing and shares state through `globalThis`.
 */

export const NITRO_ASSETS_KEY = "vinext.nitro.assets";

const ASSET_REQUEST_HEADER = "x-vinext-nitro-asset";
const STATIC_METHODS = new Set(["GET", "HEAD"]);
const ENCODING_EXTENSIONS = new Map([
  ["br", ".br"],
  ["gzip", ".gz"],
  ["zstd", ".zst"],
]);

type NitroApp = {
  fetch: (request: Request) => Response | Promise<Response>;
  captureError?: (error: unknown, context: { tags?: string[] }) => void;
};

export type NitroAssets = {
  fetch(request: Request): Promise<Response>;
  /** Whether a request is an asset fetch that Nitro's static handler did not answer. */
  isAssetRequest(request: Request): boolean;
};

type NitroPublicFilesPluginOptions = {
  /**
   * The static files Nitro serves for the files in `public/`, including
   * their compressed copies, keyed as Nitro's static handler keys them.
   */
  publicAssets: string[];
  /** Sends a request to vinext's request handler. */
  fetchApp(request: Request): Promise<Response>;
};

/**
 * The pathnames h3 can give Nitro's static handler for a request URL. srvx
 * usually hands h3 the URL's path up to the query as it is, so a literal `#`
 * stays in it, but parses the URL fully when the path needs normalizing.
 */
function getRequestPathnames(url: string): string[] {
  const parsed = new URL(url).pathname;
  const start = url.indexOf("/", url.indexOf("://") + 3);
  if (start === -1) return [parsed];
  const query = url.indexOf("?", start);
  const raw = url.slice(start, query === -1 ? undefined : query);
  return raw === parsed ? [parsed] : [parsed, raw];
}

/**
 * The pathname h3 2.0.1-rc.22, which the pinned Nitro uses, gives Nitro's
 * static handler. When it creates the request event, it decodes a pathname
 * that contains `%` except for `%25`, and the URL parser then resolves the
 * result again, for example `\` and `..` segments. Returns `undefined` when
 * h3 fails the request instead. Newer h3 releases leave decoding to Nitro, so
 * the plugin also looks up the pathname without this step.
 */
function toH3Pathname(pathname: string): string | undefined {
  if (!pathname.includes("%")) return pathname;
  try {
    const url = new URL("http://localhost");
    url.pathname = decodeURI(pathname.replace(/%25/g, "%2525"));
    return url.pathname;
  } catch {
    return undefined;
  }
}

/**
 * Whether Nitro's static handler would answer a request for a pathname with
 * a public file, following its lookup in `runtime/internal/static.mjs`. It
 * looks h3's pathname up without one trailing slash and decoded except for
 * `%2F`, and then as a directory with an `index.html`, each first with the
 * extension of a compressed copy for every encoding the request accepts.
 */
function isPublicFilePathname(
  pathname: string,
  extensions: string[],
  publicAssets: Set<string>,
): boolean {
  let id = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  try {
    id = decodeURIComponent(id.replace(/%2f/gi, "%252F"));
  } catch {
    // Nitro looks up a malformed pathname as it is.
  }
  const index = id.endsWith("/") ? `${id}index.html` : `${id}/index.html`;
  return extensions.some(
    (extension) => publicAssets.has(id + extension) || publicAssets.has(index + extension),
  );
}

function isPublicFileRequest(request: Request, publicAssets: Set<string>): boolean {
  if (!STATIC_METHODS.has(request.method)) return false;
  const extensions = [""];
  for (const encoding of request.headers.get("accept-encoding")?.split(",") ?? []) {
    // Newer Nitro releases also read weighted and uppercase encodings, and
    // skip one whose first `q` is 0 or less.
    const [name, ...params] = encoding.split(";");
    const quality = params
      .map((param) => param.trim().split("="))
      .find(([key]) => key.toLowerCase() === "q")?.[1];
    const weight = quality === undefined ? 1 : Number.parseFloat(quality);
    if (weight <= 0) continue;
    const extension = ENCODING_EXTENSIONS.get(name.trim().toLowerCase());
    if (extension) extensions.push(extension);
  }
  // Every pathname that this or a newer Nitro release might look up is
  // checked, so a public file never skips middleware. A request Nitro
  // wouldn't answer with a file, such as one with a raw `#` in its target,
  // can then go to vinext without Nitro's route rules and handlers.
  return getRequestPathnames(request.url).some((pathname) =>
    [pathname, toH3Pathname(pathname)].some(
      (candidate) =>
        candidate !== undefined && isPublicFilePathname(candidate, extensions, publicAssets),
    ),
  );
}

export function createNitroPublicFilesPlugin(
  options: NitroPublicFilesPluginOptions,
): (nitroApp: NitroApp) => void {
  const publicAssets = new Set(options.publicAssets);
  return (nitroApp) => {
    const appFetch = nitroApp.fetch;
    // Marks asset fetches so vinext can tell one that reached it apart from a
    // client request. Clients can't know the value, and it only makes vinext
    // answer 404.
    const token = crypto.randomUUID();
    const assets: NitroAssets = {
      async fetch(request) {
        const headers = new Headers(request.headers);
        headers.set(ASSET_REQUEST_HEADER, token);
        return appFetch(new Request(request, { headers }));
      },
      isAssetRequest: (request) => request.headers.get(ASSET_REQUEST_HEADER) === token,
    };
    Reflect.set(globalThis, Symbol.for(NITRO_ASSETS_KEY), assets);

    if (publicAssets.size > 0) {
      nitroApp.fetch = (request) => {
        if (!isPublicFileRequest(request, publicAssets)) return appFetch(request);
        // The Nitro app turns a handler error into an error response, but this
        // request doesn't go through it.
        return Promise.resolve()
          .then(() => options.fetchApp(request))
          .catch((error: unknown) => {
            console.error("[vinext]", error);
            nitroApp.captureError?.(error, { tags: ["vinext"] });
            return new Response(null, { status: 500 });
          });
      };
    }
  };
}
