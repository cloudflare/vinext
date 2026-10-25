/**
 * Hybrid App/Pages clients need App route handler patterns only to decide
 * route ownership, so they receive them with every static segment hashed and
 * never see the handlers' paths in plain text (issue #3624). Dynamic parts
 * stay as they are, so a hashed pattern matches a hashed URL with the usual
 * route trie. A collision can only add a false handler match, which sends the
 * navigation to the document.
 */
import { fnv1a64 } from "../utils/hash.js";
import { splitPathnameForRouteMatch } from "./utils.js";

function hashRouteSegment(segment: string): string {
  return fnv1a64(segment).slice(0, 8);
}

export function hashRoutePatternParts(patternParts: readonly string[]): string[] {
  return patternParts.map((part) => (part.startsWith(":") ? part : hashRouteSegment(part)));
}

export function hashRoutePathname(pathname: string): string {
  return "/" + splitPathnameForRouteMatch(pathname).map(hashRouteSegment).join("/");
}
