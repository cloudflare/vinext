import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { scrubDraftCookiesForServiceRoutes } from "@atlas/draft/scrub-draft-cookies";

// Regex matcher form: everything except build assets and the favicon.
export const config = {
  matcher: "/((?!_next/static|favicon.ico).*)",
};

/**
 * Extra async export alongside the middleware itself — the trials agent's
 * manifest loader lives here so edge and server code share one module.
 */
export const loadTrialsManifest = async () => {
  const response = await fetch(
    `https://manifests.atlas-fixture.test/${process.env["ATLAS_TRIALS_SDK_KEY"]}.json`,
  );
  return response.json();
};

const ZONE_SLUGS = ["us", "ca"];
const HOME_ZONE_SLUG = "us";

const skipsZoneRouting = (pathname: string): boolean =>
  pathname === "/release.txt" ||
  ["/api/", "/_next/", "/legacy/", "/atlas/cdn/"].some((prefix) =>
    pathname.startsWith(prefix),
  );

export const middleware = (req: NextRequest): NextResponse => {
  const url = req.nextUrl;
  const { pathname } = url;

  // Infra short-circuits come first: the CDN prefix, the disabled image
  // endpoint, and raw data requests (answered with a hard-navigation
  // instruction; see the hardNavTo notes in the README).
  if (pathname.startsWith("/atlas/cdn/_next/")) {
    const unprefixed = url.clone();
    unprefixed.pathname = pathname.slice("/atlas/cdn".length);
    return NextResponse.rewrite(unprefixed);
  }
  if (pathname.startsWith("/_next/image")) {
    return NextResponse.json(
      { error: "The built-in image endpoint is disabled on this deployment" },
      { status: 403 },
    );
  }
  if (pathname.startsWith("/_next/data/")) {
    // Answer data requests with a hard-navigation instruction pointing at
    // the *page* URL (strip the /_next/data/<buildId> prefix and .json).
    const pagePath =
      pathname.replace(/^\/_next\/data\/[^/]+/, "").replace(/\.json$/, "") ||
      "/";
    const search = url.searchParams.toString();
    return NextResponse.json(
      { hardNavTo: search ? `${pagePath}?${search}` : pagePath },
      { status: 200 },
    );
  }

  // Editor tooling enters draft mode via a request header.
  if (
    req.headers.get("x-editor-draft") === "true" &&
    !req.cookies.get("__prerender_bypass")?.value
  ) {
    return NextResponse.redirect(
      new URL(`/api/draft?draft=on&landing=${pathname}`, url),
    );
  }

  const scrubbed = scrubDraftCookiesForServiceRoutes(req);
  if (scrubbed) {
    return scrubbed;
  }

  if (skipsZoneRouting(pathname)) {
    return NextResponse.next();
  }

  // Zone routing, kept deliberately simple: URLs may carry one optional
  // leading zone segment. The home zone is never shown publicly, unknown
  // leading segments are treated as content paths in the home zone.
  const [, head = "", ...rest] = pathname.split("/");

  if (head === HOME_ZONE_SLUG) {
    const canonical = url.clone();
    canonical.pathname = `/${rest.join("/")}`;
    return NextResponse.redirect(canonical);
  }

  if (ZONE_SLUGS.includes(head)) {
    const passthrough = NextResponse.next();
    passthrough.headers.set("x-zone", head);
    return passthrough;
  }

  const zoned = url.clone();
  zoned.pathname = pathname === "/" ? `/${HOME_ZONE_SLUG}` : `/${HOME_ZONE_SLUG}${pathname}`;
  const rewritten = NextResponse.rewrite(zoned);
  rewritten.headers.set("x-zone", HOME_ZONE_SLUG);
  return rewritten;
};
