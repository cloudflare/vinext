import {
  matchRewrite,
  type BasePathMatchState,
  type RequestContext,
} from "../config/config-matchers.js";
import { isExternalUrl } from "../utils/external-url.js";
import type { ClientRewrite } from "./client-rewrites.js";

export function matchClientRewrite(
  pathname: string,
  rewrite: ClientRewrite,
  context: RequestContext,
  basePathState: BasePathMatchState,
): { kind: "rewrite"; destination: string } | { kind: "server" } | null {
  const destination = matchRewrite(
    pathname,
    [
      {
        source: rewrite.source,
        // Server-evaluated rules use a harmless local destination only to
        // determine whether their client-safe source/has fields match.
        destination: rewrite.destination ?? "/",
        has: rewrite.has,
        locale: rewrite.locale,
        basePath: rewrite.basePath,
      },
    ],
    context,
    basePathState,
  );
  if (destination === null) return null;
  if (rewrite.requiresServerEvaluation || isExternalUrl(destination)) {
    return { kind: "server" };
  }
  return { kind: "rewrite", destination };
}
