import type { GetServerSidePropsContext } from "next";

import type { Zone } from "@atlas/zones/zone";
import { HOME_ZONE } from "@atlas/zones/zone";

/**
 * Gallery URL hygiene: query validation, "known bad shape" detection with a
 * redirect to the deduplicated wall, and character-level sanitisation with a
 * redirect to the public canonical form.
 */

const REPEATABLE_PARAMS = new Set(["facet"]);

export const isFacetQueryAcceptable = (
  context: GetServerSidePropsContext,
): boolean => {
  for (const [key, value] of Object.entries(context.query)) {
    if (Array.isArray(value) && !REPEATABLE_PARAMS.has(key) && key !== "facets") {
      return false;
    }
  }
  const page = context.query["page"];
  if (typeof page === "string" && Number.isNaN(Number.parseInt(page, 10))) {
    return false;
  }
  return true;
};

export const wallPathFromQuery = (
  query: GetServerSidePropsContext["query"],
): string => {
  const facets = query["facets"];
  const segments = Array.isArray(facets) ? facets : facets ? [facets] : [];
  return `/gallery/${segments.join("/")}`;
};

/** A trail is malformed when a facet segment repeats back-to-back. */
export const isMalformedTrail = (
  query: GetServerSidePropsContext["query"],
  wallPath: string,
): boolean => {
  const segments = wallPath.split("/").filter(Boolean).slice(1);
  return segments.some((segment, i) => segment === segments[i - 1]);
};

export const redirectForMalformedTrail = (
  wallPath: string,
  _resolvedUrl: string,
  _ctx: { zone: Zone },
) => {
  const segments = wallPath.split("/").filter(Boolean).slice(1);
  const deduped = segments.filter((segment, i) => segment !== segments[i - 1]);
  return {
    redirect: {
      destination: `/gallery/${deduped.join("/")}`,
      permanent: false,
    },
  };
};

/**
 * Character-level clean-up: lowercase, collapse whitespace runs to dashes.
 * The redirect destination must be the *public* URL, so the internal zone
 * prefix is stripped and re-added only for non-home zones.
 */
export const scrubWallPath = ({
  resolvedUrl,
  ctx,
}: {
  resolvedUrl: string;
  ctx: { zone: Zone };
}): { isOriginalPathClean: boolean; scrubbedPath: string } => {
  const [path, queryString] = resolvedUrl.split("?");
  const scrubbedInternal = path
    .toLowerCase()
    .replace(/%20| /g, "-")
    .replace(/-{2,}/g, "-");

  let scrubbed = scrubbedInternal;
  const internalPrefix = `/${ctx.zone.slug}`;
  if (scrubbed.startsWith(`${internalPrefix}/`)) {
    const bare = scrubbed.slice(internalPrefix.length);
    scrubbed = ctx.zone.slug === HOME_ZONE.slug ? bare : `${internalPrefix}${bare}`;
  }

  return {
    isOriginalPathClean: scrubbedInternal === path,
    scrubbedPath: queryString ? `${scrubbed}?${queryString}` : scrubbed,
  };
};

export const missForWall = (): { notFound: true } => ({ notFound: true });
