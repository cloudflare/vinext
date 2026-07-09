import React from "react";
import {
  BeforeInteractiveContext,
  type BeforeInteractiveInlineScript,
} from "vinext/shims/before-interactive-context";

export type BeforeInteractiveCollector = {
  scripts: BeforeInteractiveInlineScript[];
  seal: () => void;
  wrapPageElement: (element: React.ReactElement) => React.ReactElement;
};

export function createBeforeInteractiveCollector(
  context: typeof BeforeInteractiveContext = BeforeInteractiveContext,
): BeforeInteractiveCollector {
  const scripts: BeforeInteractiveInlineScript[] = [];
  let sealed = false;

  return {
    scripts,
    seal() {
      sealed = true;
    },
    wrapPageElement(element) {
      return React.createElement(
        context.Provider,
        {
          value(script: BeforeInteractiveInlineScript) {
            if (sealed) return "inline";
            scripts.push(script);
            return "hoisted";
          },
        },
        element,
      );
    },
  };
}
