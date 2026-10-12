type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

function headingText(node: Node): string {
  return node.type === "text"
    ? (node.value ?? "")
    : (node.children?.map(headingText).join("") ?? "");
}

export function rehypeHeadingLinks() {
  return (tree: Node) => {
    const ids = new Set<string>();

    function visit(node: Node) {
      if (node.type === "element" && /^h[1-6]$/.test(node.tagName ?? "")) {
        const title = headingText(node);
        const slug =
          title
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
            .replace(/\s+/g, "-") || "section";
        let id = slug;
        let suffix = 0;
        while (ids.has(id)) id = `${slug}-${++suffix}`;
        ids.add(id);
        node.properties = { ...node.properties, id };
        node.children?.unshift({
          type: "element",
          tagName: "a",
          properties: {
            href: `#${id}`,
            className: ["docs-heading-link"],
            ariaLabel: `Link to ${title}`,
          },
          children: [
            {
              type: "element",
              tagName: "span",
              properties: { ariaHidden: "true" },
              children: [{ type: "text", value: "#" }],
            },
          ],
        });
      }
      node.children?.forEach(visit);
    }

    visit(tree);
  };
}
