export type TraceNode = {
  name: string;
  value: number;
  source?: string;
  category?: string;
  children?: TraceNode[];
};

export type TraceCategory = "vinext" | "vite" | "rolldown" | "node" | "other";

export function selfValue(node: TraceNode) {
  return Math.max(
    0,
    node.value - (node.children ?? []).reduce((total, child) => total + child.value, 0),
  );
}

export function filteredTraceGraph<T extends TraceNode>(
  fullGraph: T | null | undefined,
  filters: Set<TraceCategory> | null,
): T | null {
  if (!fullGraph) return null;
  if (filters === null) return fullGraph;

  const children = filteredTraceChildren(fullGraph.children ?? [], filters);
  const value = children.reduce((total, child) => total + child.value, 0);
  return {
    name: "filtered samples",
    value,
    category: "process",
    children,
  } as T;
}

function filteredTraceChildren<T extends TraceNode>(nodes: T[], filters: Set<TraceCategory>): T[] {
  return nodes.flatMap((node) => {
    const children = filteredTraceChildren((node.children ?? []) as T[], filters);
    const matches = filters.has(traceCategory(node));
    if (!matches && children.length === 0) return [];
    if (!matches && isUninformativeContextFrame(node)) return children;
    return [
      {
        ...node,
        value: matches ? node.value : children.reduce((total, child) => total + child.value, 0),
        children: children.length > 0 ? children : undefined,
      },
    ];
  });
}

function isUninformativeContextFrame(node: TraceNode) {
  if (node.source || traceCategory(node) !== "other") return false;
  return (
    node.category === "native" ||
    /^0x[0-9a-f]+$/i.test(node.name) ||
    /\s0x[0-9a-f]+$/i.test(node.name)
  );
}

function traceCategory(node: TraceNode): TraceCategory {
  if (
    node.category === "vinext" ||
    node.category === "vite" ||
    node.category === "rolldown" ||
    node.category === "node"
  ) {
    return node.category;
  }
  return "other";
}
