declare module "@babel/core" {
  export function transformAsync(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{
    code?: string | null;
    map?: {
      version: number;
      sources: string[];
      names: string[];
      mappings: string;
      file?: string;
      sourceRoot?: string;
      sourcesContent?: Array<string | null>;
    } | null;
  } | null>;
}

declare module "styled-jsx/babel" {
  const plugin: unknown;
  export default plugin;
}
