import type { BrowserRouteManifest } from "../routing/browser-route-manifest.js";
import { matchRoutePattern } from "../routing/route-pattern.js";
import { splitPathnameForRouteMatch } from "../routing/utils.js";
import {
  AppElementsWire,
  type AppElementsInterception,
  type AppElementsSlotBinding,
} from "./app-elements.js";
import { matchOptimisticRouteManifestRoute } from "./app-optimistic-routing.js";

// Synthetic slot of an interception marker without an @slot wrapper. Its page
// renders as the owner's children, so Next.js reports it as the primary route.
// Matches SIBLING_INTERCEPT_SLOT_NAME in routing/app-route-graph.ts.
const SIBLING_INTERCEPT_SLOT_NAME = "__vinext_sibling_intercept";

type TransitionRouteState = Readonly<{
  interception: AppElementsInterception | null;
  routeId: string;
  slotBindings: readonly AppElementsSlotBinding[];
}>;

function isRouteGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/** A manifest pattern part in source form: `:id` → `[id]`, `:slug+` → `[...slug]`. */
function toSourceSegment(part: string): string {
  if (!part.startsWith(":")) return part;
  if (part.endsWith("+")) return `[...${part.slice(1, -1)}]`;
  if (part.endsWith("*")) return `[[...${part.slice(1, -1)}]]`;
  return `[${part.slice(1)}]`;
}

function joinSourcePath(segments: readonly string[]): string {
  return `/${segments.filter((segment) => segment.length > 0 && !isRouteGroupSegment(segment)).join("/")}`;
}

function routePathFromId(routeId: string): string | null {
  const parsed = AppElementsWire.parseElementKey(routeId);
  return parsed?.kind === "route" ? parsed.path : null;
}

function matchManifestRoute(
  routePath: string,
  routeManifest: BrowserRouteManifest | null,
): { id: string; patternParts: readonly string[] } | null {
  if (routeManifest === null) return null;
  return (
    matchOptimisticRouteManifestRoute({ basePath: "", href: routePath, routeManifest })?.route ??
    null
  );
}

function resolveRouteSourcePath(
  routePath: string,
  routeManifest: BrowserRouteManifest | null,
): string {
  const route = matchManifestRoute(routePath, routeManifest);
  if (route === null) return routePath;
  return joinSourcePath(route.patternParts.map(toSourceSegment));
}

function resolveInterceptionSourcePagePath(
  interception: AppElementsInterception,
  interceptionId: string | null | undefined,
  routeManifest: BrowserRouteManifest | null,
): string | null {
  if (routeManifest === null) return null;
  const graph = routeManifest.segmentGraph;
  const byId = interceptionId ? graph.interceptions.get(interceptionId) : undefined;
  if (byId?.sourcePagePath) return byId.sourcePagePath;
  const targetParts = splitPathnameForRouteMatch(interception.targetMatchedUrl);
  const match = graph.interceptionsBySlotId
    .get(interception.slotId)
    ?.find((candidate) => matchRoutePattern(targetParts, candidate.targetPatternParts) !== null);
  return match?.sourcePagePath ?? null;
}

function resolveSlotSourcePath(
  binding: AppElementsSlotBinding,
  slotBase: readonly string[],
  routeManifest: BrowserRouteManifest | null,
): string {
  if (binding.state !== "active" || binding.activeRouteId == null) {
    return joinSourcePath([...slotBase, "default"]);
  }
  const activeRoutePath = routePathFromId(binding.activeRouteId);
  const activeRoute =
    activeRoutePath === null ? null : matchManifestRoute(activeRoutePath, routeManifest);
  const manifestBinding =
    activeRoute === null
      ? undefined
      : routeManifest?.segmentGraph.slotBindings.get(`${activeRoute.id}::${binding.slotId}`);
  if (manifestBinding?.state === "active" && manifestBinding.routeSegments) {
    return joinSourcePath([...slotBase, ...manifestBinding.routeSegments]);
  }
  if (manifestBinding === undefined) return joinSourcePath(slotBase);
  return joinSourcePath([...slotBase, "default"]);
}

/**
 * The source route patterns of the committed App Router tree, as Next.js
 * reports them in `RouterTransitionStartEvent.fromRoutes`: the primary
 * (children) route first, then one entry per parallel slot, sorted. Route
 * groups are omitted, a slot showing its default reports `@slot/default`, and
 * an intercepted slot reports the intercepting page's directory.
 *
 * Ref: packages/next/src/client/components/router-transition.ts
 * (getActiveRoutePaths)
 */
export function resolveRouterTransitionFromRoutes(
  state: TransitionRouteState,
  routeManifest: BrowserRouteManifest | null,
): string[] {
  const interception = state.interception;
  const interceptionSlot =
    interception === null ? null : AppElementsWire.parseElementKey(interception.slotId);
  const siblingInterceptPath =
    interception !== null &&
    interceptionSlot?.kind === "slot" &&
    interceptionSlot.name === SIBLING_INTERCEPT_SLOT_NAME
      ? resolveInterceptionSourcePagePath(interception, null, routeManifest)
      : null;

  const primaryRoutePath = routePathFromId(interception?.sourceRouteId ?? state.routeId);
  const primary =
    siblingInterceptPath ??
    (primaryRoutePath === null ? null : resolveRouteSourcePath(primaryRoutePath, routeManifest));

  const slots: string[] = [];
  for (const binding of state.slotBindings) {
    const slot = AppElementsWire.parseElementKey(binding.slotId);
    if (
      slot?.kind !== "slot" ||
      slot.name === "children" ||
      slot.name === SIBLING_INTERCEPT_SLOT_NAME
    ) {
      continue;
    }
    if (interception !== null && interception.slotId === binding.slotId) {
      const intercepted = resolveInterceptionSourcePagePath(
        interception,
        binding.interceptionId,
        routeManifest,
      );
      if (intercepted !== null) {
        slots.push(intercepted);
        continue;
      }
    }
    slots.push(
      resolveSlotSourcePath(binding, [...slot.treePath.split("/"), `@${slot.name}`], routeManifest),
    );
  }

  slots.sort((left, right) => left.localeCompare(right));
  return primary === null ? slots : [primary, ...slots];
}
