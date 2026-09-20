/// <reference types="vite/client" />

declare module "*.mdx" {
  import type { ComponentType } from "react";
  const content: ComponentType;
  export const metadata: Record<string, unknown>;
  export default content;
}
