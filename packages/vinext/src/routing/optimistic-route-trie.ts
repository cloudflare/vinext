import { buildParams } from "./utils.js";

type OptimisticTrieRoute = { readonly patternParts: readonly string[] };

export type OptimisticRouteTrieNode<Route extends OptimisticTrieRoute> = {
  catchAllChild: { paramName: string; route: Route } | null;
  dynamicChild: { node: OptimisticRouteTrieNode<Route>; paramName: string } | null;
  optionalCatchAllChild: { paramName: string; route: Route } | null;
  route: Route | null;
  staticChildren: Map<string, OptimisticRouteTrieNode<Route>>;
};

export type OptimisticRouteTrieMatch<Route extends OptimisticTrieRoute> = {
  params: Record<string, string | string[]>;
  route: Route;
};

function createNode<Route extends OptimisticTrieRoute>(): OptimisticRouteTrieNode<Route> {
  return {
    catchAllChild: null,
    dynamicChild: null,
    optionalCatchAllChild: null,
    route: null,
    staticChildren: new Map(),
  };
}

export function buildOptimisticRouteTrie<Route extends OptimisticTrieRoute>(
  routes: Iterable<Route>,
  onDynamicSegmentConflict?: (existingParamName: string, part: string) => void,
): OptimisticRouteTrieNode<Route> {
  const root = createNode<Route>();

  for (const route of routes) {
    let node = root;
    const parts = route.patternParts;

    if (parts.length === 0) {
      node.route ??= route;
      continue;
    }

    for (const [index, part] of parts.entries()) {
      const isTerminal = index === parts.length - 1;
      if (part.startsWith(":") && part.endsWith("+")) {
        if (isTerminal && node.catchAllChild === null) {
          node.catchAllChild = { paramName: part.slice(1, -1), route };
        }
        break;
      }

      if (part.startsWith(":") && part.endsWith("*")) {
        if (isTerminal && node.optionalCatchAllChild === null) {
          node.optionalCatchAllChild = { paramName: part.slice(1, -1), route };
        }
        break;
      }

      if (part.startsWith(":")) {
        const paramName = part.slice(1);
        if (node.dynamicChild === null) {
          node.dynamicChild = { node: createNode(), paramName };
        } else if (node.dynamicChild.paramName !== paramName) {
          onDynamicSegmentConflict?.(node.dynamicChild.paramName, part);
        }
        node = node.dynamicChild.node;
        if (isTerminal) node.route ??= route;
        continue;
      }

      let staticChild = node.staticChildren.get(part);
      if (staticChild === undefined) {
        staticChild = createNode();
        node.staticChildren.set(part, staticChild);
      }
      node = staticChild;
      if (isTerminal) node.route ??= route;
    }
  }

  return root;
}

function matchNode<Route extends OptimisticTrieRoute>(
  node: OptimisticRouteTrieNode<Route>,
  urlParts: readonly string[],
  index: number,
  entries: Array<[string, string | string[]]>,
): OptimisticRouteTrieMatch<Route> | null {
  if (index === urlParts.length) {
    if (node.route !== null) {
      return { route: node.route, params: buildParams(entries) };
    }
    if (node.optionalCatchAllChild !== null) {
      return {
        route: node.optionalCatchAllChild.route,
        params: buildParams(entries),
      };
    }
    return null;
  }

  const segment = urlParts[index];
  const staticChild = node.staticChildren.get(segment);
  if (staticChild !== undefined) {
    // Static children are authoritative for optimistic routing. If a known
    // static subtree does not contain the remaining URL, do not fall through to
    // a catch-all sibling and render the wrong loading boundary.
    return matchNode(staticChild, urlParts, index + 1, entries);
  }

  if (node.dynamicChild !== null) {
    entries.push([node.dynamicChild.paramName, segment]);
    const match = matchNode(node.dynamicChild.node, urlParts, index + 1, entries);
    if (match !== null) return match;
    entries.pop();
  }

  if (node.catchAllChild !== null) {
    const params = buildParams(entries);
    params[node.catchAllChild.paramName] = urlParts.slice(index);
    return { route: node.catchAllChild.route, params };
  }

  // At this point index < urlParts.length, so remaining always has ≥1 segment.
  if (node.optionalCatchAllChild !== null) {
    const params = buildParams(entries);
    params[node.optionalCatchAllChild.paramName] = urlParts.slice(index);
    return { route: node.optionalCatchAllChild.route, params };
  }

  return null;
}

export function matchOptimisticRouteTrie<Route extends OptimisticTrieRoute>(
  trie: OptimisticRouteTrieNode<Route>,
  urlParts: readonly string[],
): OptimisticRouteTrieMatch<Route> | null {
  return matchNode(trie, urlParts, 0, []);
}
