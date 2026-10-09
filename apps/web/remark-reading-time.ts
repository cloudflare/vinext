type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: unknown;
};

type Root = Node & { children: Node[] };

const WORDS_PER_MINUTE = 230;

function countWords(node: Node): number {
  // Code blocks are skimmed rather than read, so they don't count towards reading time.
  if (node.type === "code" || node.type === "yaml") return 0;
  if (node.type === "text" || node.type === "inlineCode") {
    return node.value?.split(/\s+/).filter(Boolean).length ?? 0;
  }
  return node.children?.reduce((total, child) => total + countWords(child), 0) ?? 0;
}

/** Export `readingMinutes`, an estimate of how long the document's prose takes to read. */
export function remarkReadingTime() {
  return (tree: Root) => {
    const minutes = Math.max(1, Math.round(countWords(tree) / WORDS_PER_MINUTE));
    tree.children.push({
      type: "mdxjsEsm",
      value: `export const readingMinutes = ${minutes};`,
      data: {
        estree: {
          type: "Program",
          sourceType: "module",
          body: [
            {
              type: "ExportNamedDeclaration",
              specifiers: [],
              source: null,
              declaration: {
                type: "VariableDeclaration",
                kind: "const",
                declarations: [
                  {
                    type: "VariableDeclarator",
                    id: { type: "Identifier", name: "readingMinutes" },
                    init: { type: "Literal", value: minutes, raw: String(minutes) },
                  },
                ],
              },
            },
          ],
        },
      },
    });
  };
}
