/**
 * Reports the next/dynamic modules a Pages Router server render uses, like
 * Next.js's LoadableContext. The Pages render pipeline provides a collector,
 * and the rendered module ids become `__NEXT_DATA__.dynamicIds`, which the
 * browser preloads before hydrating.
 *
 * Stored on a global symbol so duplicate module instances (the dev server and
 * its module runner) share one context, and null in react-server, which has
 * no createContext.
 */
import React from "react";

type CaptureFn = (moduleId: string) => void;

const LOADABLE_CONTEXT_KEY = Symbol.for("vinext.loadableContext");

type LoadableContextGlobal = typeof globalThis & {
  [LOADABLE_CONTEXT_KEY]?: React.Context<CaptureFn | null>;
};

function getLoadableContext(): React.Context<CaptureFn | null> | null {
  if (typeof React.createContext !== "function") return null;
  const globalState = globalThis as LoadableContextGlobal;
  globalState[LOADABLE_CONTEXT_KEY] ??= React.createContext<CaptureFn | null>(null);
  return globalState[LOADABLE_CONTEXT_KEY];
}

export const LoadableContext: React.Context<CaptureFn | null> | null = getLoadableContext();

export type LoadableModuleCollector = {
  /** Wraps a render tree so its next/dynamic components report their modules. */
  wrap(children: React.ReactNode): React.ReactElement;
  /** The reported module ids, or undefined when none rendered (as in Next.js). */
  getDynamicIds(): string[] | undefined;
};

export function createLoadableModuleCollector(): LoadableModuleCollector {
  const moduleIds = new Set<string>();
  const capture: CaptureFn = (moduleId) => {
    moduleIds.add(moduleId);
  };
  return {
    wrap(children) {
      return LoadableContext
        ? React.createElement(LoadableContext.Provider, { value: capture }, children)
        : React.createElement(React.Fragment, null, children);
    },
    getDynamicIds() {
      return moduleIds.size > 0 ? Array.from(moduleIds) : undefined;
    },
  };
}
