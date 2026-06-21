import type { ComponentType, ReactNode } from "react";
import "styled-jsx";

declare module "styled-jsx" {
  export type StyleRegistryInstance = StyledJsxStyleRegistry;
  export const style: ComponentType<StyledJsxStyleProps> & {
    dynamic(info: readonly (readonly [string, readonly unknown[]])[]): string;
  };

  export type StyledJsxStyleProps = {
    id: string;
    dynamic?: readonly unknown[];
    children?: ReactNode;
  };
}
