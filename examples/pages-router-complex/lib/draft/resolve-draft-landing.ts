import type { ParsedUrlQuery } from "node:querystring";

export type DraftLandingOpts = {
  credentialScope: string;
  product: string;
  requestUrl?: string;
};

/**
 * Maps copy-platform draft requests onto app routes. The editor tooling
 * calls `/api/draft?kind=story&ref=<id>` (or passes an explicit `landing`
 * path); this decides where the editor lands. Unknown kinds resolve to
 * undefined so the gateway can reject them.
 */
export const resolveDraftLanding = async (
  query: ParsedUrlQuery,
  _opts: DraftLandingOpts,
): Promise<string | undefined> => {
  const explicitLanding = query["landing"];
  if (typeof explicitLanding === "string" && explicitLanding.length > 0) {
    return explicitLanding;
  }

  const kind = query["kind"];
  const ref = query["ref"];
  if (typeof kind === "string" && typeof ref === "string") {
    switch (kind) {
      case "story":
        return `/journal/${ref}`;
      case "wall":
        return `/gallery/${ref}`;
      case "front":
        return "/";
      default:
        return undefined;
    }
  }

  return "/";
};
