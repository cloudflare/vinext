import React, { isValidElement, type ReactElement, type ReactNode } from "react";
import { StyleRegistry, createStyleRegistry } from "styled-jsx";

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function createPagesStyledJsxRegistry() {
  const registry = createStyleRegistry();

  return {
    wrap(element: ReactNode): ReactElement {
      return React.createElement(
        StyleRegistry as React.ComponentType<{ registry: typeof registry }>,
        { registry },
        element,
      );
    },
    stylesHTML(options?: { nonce?: string }): string {
      const styles = registry.styles(options);
      registry.flush();
      return styles
        .map((style) => {
          if (!isValidElement(style)) return "";
          const props = style.props as {
            id?: string;
            nonce?: string;
            dangerouslySetInnerHTML?: { __html?: string };
          };
          const id = props.id ? ` id="${escapeAttribute(props.id)}"` : "";
          const nonce = props.nonce ? ` nonce="${escapeAttribute(props.nonce)}"` : "";
          return `<style${id}${nonce}>${props.dangerouslySetInnerHTML?.__html ?? ""}</style>`;
        })
        .join("");
    },
  };
}
