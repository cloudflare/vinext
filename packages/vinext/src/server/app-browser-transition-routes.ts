import type { BrowserRouteManifest } from "../routing/browser-route-manifest.js";
import { matchRoutePattern } from "../routing/route-pattern.js";
import { splitPathnameForRouteMatch } from "../routing/utils.js";
import { rendersSiblingIntercept } from "./app-browser-state.js";
import {
  AppElementsWire,
  type AppElements,
  type AppElementsInterception,
  type AppElementsSlotBinding,
} from "./app-elements.js";
import { matchOptimisticRouteManifestRoute } from "./app-optimistic-routing.js";

// Synthetic slot of an interception marker without an @slot wrapper. Its page
// renders as the owner's children, which the committed source page reports.
// Matches SIBLING_INTERCEPT_SLOT_NAME in routing/app-route-graph.ts.
const SIBLING_INTERCEPT_SLOT_NAME = "__vinext_sibling_intercept";

type TransitionRouteState = Readonly<{
  elements: AppElements;
  interception: AppElementsInterception | null;
  slotBindings: readonly AppElementsSlotBinding[];
}>;

function isRouteGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
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

function resolveInterceptionSourcePagePath(
  binding: AppElementsSlotBinding,
  interception: AppElementsInterception | null,
  routeManifest: BrowserRouteManifest | null,
): string | null {
  if (routeManifest === null) return null;
  const graph = routeManifest.segmentGraph;
  // A merge can keep an intercepted slot from an earlier payload, so the
  // binding's own interception id decides, not only the latest interception.
  const byId = binding.interceptionId ? graph.interceptions.get(binding.interceptionId) : undefined;
  if (byId?.sourcePagePath) return byId.sourcePagePath;
  if (interception === null || interception.slotId !== binding.slotId) return null;
  const targetParts = splitPathnameForRouteMatch(interception.targetMatchedUrl);
  const match = graph.interceptionsBySlotId
    .get(interception.slotId)
    ?.find((candidate) => matchRoutePattern(targetParts, candidate.targetPatternParts) !== null);
  return match?.sourcePagePath ?? null;
}

function treePathSegments(treePath: string): string[] {
  return treePath.split("/").filter(Boolean);
}

/** The committed source page's directory segments, or null on a route miss. */
function sourcePageDirectory(sourcePage: string | null): string[] | null {
  if (sourcePage === null) return null;
  const segments = sourcePage.split("/").filter(Boolean);
  return segments.at(-1) === "page" ? segments.slice(0, -1) : segments;
}

function startsWithSegments(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, index) => segments[index] === segment);
}

function resolveSlotSourcePath(
  binding: AppElementsSlotBinding,
  slotBase: readonly string[],
  routeManifest: BrowserRouteManifest | null,
): string {
  if (binding.state !== "active" || binding.activeRouteId == null) {
    return joinSourcePath([...slotBase, "default"]);
  }
  // An ordinary slot's active route id is the manifest route id (`route:`
  // plus its pattern). Only an id that isn't one, such as a concrete
  // interception target, is matched as a URL.
  const activeRoutePath = routePathFromId(binding.activeRouteId);
  const activeRoute =
    routeManifest?.segmentGraph.routes.get(binding.activeRouteId) ??
    (activeRoutePath === null ? null : matchManifestRoute(activeRoutePath, routeManifest));
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

type WholeInterceptedSlot = {
  binding: AppElementsSlotBinding;
  ownerSegments: string[];
  path: string;
};

function resolveWholeInterceptedSlot(
  bindings: readonly AppElementsSlotBinding[],
  sourceSegments: readonly string[],
  routeManifest: BrowserRouteManifest | null,
): WholeInterceptedSlot | null {
  const candidates: WholeInterceptedSlot[] = [];
  for (const binding of bindings) {
    const slot = AppElementsWire.parseElementKey(binding.slotId);
    if (slot?.kind !== "slot" || slot.name === "children" || binding.state !== "active") continue;
    const ownerSegments = treePathSegments(slot.treePath);
    if (!startsWithSegments(sourceSegments, ownerSegments)) continue;
    const path = joinSourcePath([
      ...ownerSegments,
      `@${slot.name}`,
      ...sourceSegments.slice(ownerSegments.length),
    ]);
    candidates.push({ binding, ownerSegments, path });
  }
  return (
    candidates.find((candidate) =>
      routeManifest?.segmentGraph.interceptionsBySlotId
        .get(candidate.binding.slotId)
        ?.some((interception) => interception.sourcePagePath === candidate.path),
    ) ??
    candidates[0] ??
    null
  );
}

/**
 * The source route patterns of the committed App Router tree, as Next.js
 * reports them in `RouterTransitionStartEvent.fromRoutes`: the primary
 * (children) route first, then one entry per parallel slot, sorted. Route
 * groups are omitted, a slot or children showing its default reports
 * `.../default`, an intercepted slot reports the intercepting page's
 * directory, and a URL that matched no route reports `/_not-found`.
 *
 * The route manifest loads alongside hydration, not before it. A transition
 * that starts before it arrives reports an active slot as its slot directory.
 *
 * Ref: packages/next/src/client/components/router-transition.ts
 * (getActiveRoutePaths)
 */
export function resolveRouterTransitionFromRoutes(
  state: TransitionRouteState,
  routeManifest: BrowserRouteManifest | null,
): string[] {
  const metadata = AppElementsWire.readMetadata(state.elements);
  const sourceSegments = sourcePageDirectory(metadata.sourcePage);
  // A render of a whole intercepting route shows the owner's default as its
  // children and the intercepting page in its slot. Its source page is the
  // intercepting page's, without the slot's own segment. A merge can keep
  // another active slot, so the manifest's interceptions pick the slot.
  const wholeIntercepted =
    metadata.wholeInterceptionSource === null || sourceSegments === null
      ? null
      : resolveWholeInterceptedSlot(state.slotBindings, sourceSegments, routeManifest);

  let primary: string;
  if (sourceSegments === null) {
    primary = "/_not-found";
  } else if (wholeIntercepted !== null) {
    primary = joinSourcePath([...wholeIntercepted.ownerSegments, "default"]);
  } else {
    // The deepest children slot above the page decides whether the children
    // render its page or its default, as a synthetic parallel sub-route's do.
    let children: { binding: AppElementsSlotBinding; owner: string[] } | null = null;
    if (!rendersSiblingIntercept(metadata)) {
      for (const binding of state.slotBindings) {
        const slot = AppElementsWire.parseElementKey(binding.slotId);
        if (slot?.kind !== "slot" || slot.name !== "children") continue;
        const owner = treePathSegments(slot.treePath);
        if (!startsWithSegments(sourceSegments, owner)) continue;
        if (children === null || owner.length > children.owner.length) {
          children = { binding, owner };
        }
      }
    }
    primary =
      children !== null && children.binding.state !== "active"
        ? joinSourcePath([...children.owner, "default"])
        : joinSourcePath(sourceSegments);
  }

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
    if (binding === wholeIntercepted?.binding) {
      slots.push(wholeIntercepted.path);
      continue;
    }
    const intercepted = resolveInterceptionSourcePagePath(
      binding,
      state.interception,
      routeManifest,
    );
    if (intercepted !== null) {
      slots.push(intercepted);
      continue;
    }
    slots.push(
      resolveSlotSourcePath(binding, [...slot.treePath.split("/"), `@${slot.name}`], routeManifest),
    );
  }

  slots.sort((left, right) => left.localeCompare(right));
  return [primary, ...slots];
}
