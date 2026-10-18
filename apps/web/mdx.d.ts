declare module "*.mdx" {
  import type { ComponentType } from "react";
  const content: ComponentType;
  export const metadata: Record<string, unknown>;
  export default content;
}

declare module "*.md" {
  import type { ComponentType } from "react";
  const content: ComponentType;
  export const frontmatter: Record<string, unknown> | undefined;
  export const readingMinutes: number;
  export default content;
}
