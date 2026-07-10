"use client";

import DefaultGlobalErrorRender, {
  type DefaultGlobalErrorProps,
} from "./default-global-error-render.js";

export type { DefaultGlobalErrorProps } from "./default-global-error-render.js";

export default function DefaultGlobalError(props: DefaultGlobalErrorProps) {
  return <DefaultGlobalErrorRender {...props} />;
}
