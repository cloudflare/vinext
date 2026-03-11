/**
 * Trie (prefix tree) for O(depth) route matching.
 *
 * Replaces the O(n) linear scan over pre-sorted routes with a trie-based
 * lookup. Priority is enforced by traversal order at each node:
 *   1. Static child (exact segment match) — highest priority
 *   2. Dynamic child (single-segment param) — medium
 *   3. Catch-all (1+ remaining segments) — low
 *   4. Optional catch-all (0+ remaining segments) — lowest
 *
 * Backtracking via recursive DFS ensures that dead-end static/dynamic
 * branches fall through to catch-all alternatives.
 */

export interface TrieNode<R> {
  staticChildren: Map<string, TrieNode<R>>;
  dynamicChild: { paramName: string; node: TrieNode<R> } | null;
  catchAllChild: { paramName: string; route: R } | null;
  optionalCatchAllChild: { paramName: string; route: R } | null;
  route: R | null;
}

function createNode<R>(): TrieNode<R> {
  return {
    staticChildren: new Map(),
    dynamicChild: null,
    catchAllChild: null,
    optionalCatchAllChild: null,
    route: null,
  };
}

/**
 * Build a trie from pre-sorted routes.
 *
 * Routes must have a `patternParts` property (string[] of URL segments).
 * Pattern segment conventions:
 *   - `:name`  — dynamic segment
 *   - `:name+` — catch-all (1+ segments)
 *   - `:name*` — optional catch-all (0+ segments)
 *   - anything else — static segment
 *
 * First route to claim a terminal position wins (routes are pre-sorted
 * by precedence, so insertion order preserves correct priority).
 */
export function buildRouteTrie<R extends { patternParts: string[] }>(routes: R[]): TrieNode<R> {
  const root = createNode<R>();

  for (const route of routes) {
    const parts = route.patternParts;

    // Root route (patternParts = [])
    if (parts.length === 0) {
      if (root.route === null) {
        root.route = route;
      }
      continue;
    }

    let node = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      // Catch-all: :name+ (must be terminal — skip malformed non-terminal catch-alls)
      if (part.endsWith("+") && part.startsWith(":")) {
        if (i !== parts.length - 1) break; // malformed: not terminal
        const paramName = part.slice(1, -1);
        if (node.catchAllChild === null) {
          node.catchAllChild = { paramName, route };
        }
        break;
      }

      // Optional catch-all: :name* (must be terminal — skip malformed non-terminal)
      if (part.endsWith("*") && part.startsWith(":")) {
        if (i !== parts.length - 1) break; // malformed: not terminal
        const paramName = part.slice(1, -1);
        if (node.optionalCatchAllChild === null) {
          node.optionalCatchAllChild = { paramName, route };
        }
        break;
      }

      // Dynamic segment: :name
      if (part.startsWith(":")) {
        const paramName = part.slice(1);
        if (node.dynamicChild === null) {
          node.dynamicChild = { paramName, node: createNode<R>() };
        }
        node = node.dynamicChild.node;

        // If this is the last segment, set the route
        if (i === parts.length - 1) {
          if (node.route === null) {
            node.route = route;
          }
        }
        continue;
      }

      // Static segment
      let child = node.staticChildren.get(part);
      if (!child) {
        child = createNode<R>();
        node.staticChildren.set(part, child);
      }
      node = child;

      // If this is the last segment, set the route
      if (i === parts.length - 1) {
        if (node.route === null) {
          node.route = route;
        }
      }
    }
  }

  return root;
}

/**
 * Match a URL against the trie.
 *
 * @param root - Trie root built by `buildRouteTrie`
 * @param urlParts - Pre-split URL segments (no empty strings)
 * @returns Match result with route and extracted params, or null
 */
export function trieMatch<R>(
  root: TrieNode<R>,
  urlParts: string[],
): { route: R; params: Record<string, string | string[]> } | null {
  return match(root, urlParts, 0);
}

function match<R>(
  node: TrieNode<R>,
  urlParts: string[],
  index: number,
): { route: R; params: Record<string, string | string[]> } | null {
  // All URL segments consumed
  if (index === urlParts.length) {
    // Exact match at this node
    if (node.route !== null) {
      return { route: node.route, params: Object.create(null) };
    }

    // Optional catch-all with 0 segments
    if (node.optionalCatchAllChild !== null) {
      const params: Record<string, string | string[]> = Object.create(null);
      params[node.optionalCatchAllChild.paramName] = [];
      return { route: node.optionalCatchAllChild.route, params };
    }

    return null;
  }

  const segment = urlParts[index];

  // 1. Try static child (highest priority)
  const staticChild = node.staticChildren.get(segment);
  if (staticChild) {
    const result = match(staticChild, urlParts, index + 1);
    if (result !== null) {
      return result;
    }
  }

  // 2. Try dynamic child (single segment)
  if (node.dynamicChild !== null) {
    const result = match(node.dynamicChild.node, urlParts, index + 1);
    if (result !== null) {
      result.params[node.dynamicChild.paramName] = segment;
      return result;
    }
  }

  // 3. Try catch-all (1+ remaining segments)
  if (node.catchAllChild !== null) {
    const remaining = urlParts.slice(index);
    const params: Record<string, string | string[]> = Object.create(null);
    params[node.catchAllChild.paramName] = remaining;
    return { route: node.catchAllChild.route, params };
  }

  // 4. Try optional catch-all (0+ remaining segments)
  if (node.optionalCatchAllChild !== null) {
    const remaining = urlParts.slice(index);
    const params: Record<string, string | string[]> = Object.create(null);
    params[node.optionalCatchAllChild.paramName] = remaining;
    return { route: node.optionalCatchAllChild.route, params };
  }

  return null;
}
