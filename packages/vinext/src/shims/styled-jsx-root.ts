import * as styledJsx from "styled-jsx/dist/index/index.js";
import type * as StyledJsxTypes from "styled-jsx";

const runtime = styledJsx as unknown as typeof StyledJsxTypes;

export const StyleRegistry = runtime.StyleRegistry;
export const createStyleRegistry = runtime.createStyleRegistry;
export const style = runtime.style;
export const useStyleRegistry = runtime.useStyleRegistry;
