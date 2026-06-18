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
    if (!filters.has(traceCategory(node))) return children;
    return [
      {
        ...node,
        children: children.length > 0 ? children : undefined,
      },
    ];
  });
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
