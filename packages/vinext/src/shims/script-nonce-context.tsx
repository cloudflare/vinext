import React from "react";

export const ScriptNonceContext =
  typeof React.createContext === "function"
    ? React.createContext<string | undefined>(undefined)
    : null;
export const InitialStylesheetContext =
  typeof React.createContext === "function"
    ? React.createContext<ReadonlySet<string> | undefined>(undefined)
    : null;

export function ScriptNonceProvider(
  props: React.PropsWithChildren<{
    nonce?: string;
    initialStylesheetHrefs?: ReadonlySet<string>;
  }>,
): React.ReactElement {
  let children = props.children;
  if (InitialStylesheetContext) {
    children = React.createElement(
      InitialStylesheetContext.Provider,
      { value: props.initialStylesheetHrefs },
      children,
    );
  }
  return ScriptNonceContext
    ? React.createElement(ScriptNonceContext.Provider, { value: props.nonce }, children)
    : React.createElement(React.Fragment, null, children);
}

export function withScriptNonce(
  element: React.ReactElement,
  nonce?: string,
  initialStylesheetHrefs?: ReadonlySet<string>,
): React.ReactElement {
  if (!nonce && !initialStylesheetHrefs) {
    return element;
  }

  return React.createElement(ScriptNonceProvider, { nonce, initialStylesheetHrefs }, element);
}

function createScriptNonceHook(context: typeof ScriptNonceContext): () => string | undefined {
  if (!context || typeof React.useContext !== "function") {
    return function useScriptNonceFromContext(): string | undefined {
      return undefined;
    };
  }

  return function useScriptNonceFromContext(): string | undefined {
    return React.useContext(context);
  };
}

const useScriptNonceFromContext = createScriptNonceHook(ScriptNonceContext);
const useInitialStylesheetsFromContext = InitialStylesheetContext
  ? () => React.useContext(InitialStylesheetContext)
  : () => undefined;

export function useScriptNonce(): string | undefined {
  return useScriptNonceFromContext();
}

export function useInitialStylesheetHrefs(): ReadonlySet<string> | undefined {
  return useInitialStylesheetsFromContext();
}
