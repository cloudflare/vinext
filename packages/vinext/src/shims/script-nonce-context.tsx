import React from "react";

export const ScriptNonceContext =
  typeof React.createContext === "function"
    ? React.createContext<string | undefined>(undefined)
    : null;

export function ScriptNonceProvider(
  props: React.PropsWithChildren<{
    nonce?: string;
  }>,
): React.ReactElement {
  if (!ScriptNonceContext) {
    return React.createElement(React.Fragment, null, props.children);
  }
  return React.createElement(ScriptNonceContext.Provider, { value: props.nonce }, props.children);
}

export function withScriptNonce(element: React.ReactElement, nonce?: string): React.ReactElement {
  if (!nonce || !ScriptNonceContext) {
    return element;
  }

  return React.createElement(ScriptNonceProvider, { nonce }, element);
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

export function useScriptNonce(): string | undefined {
  return useScriptNonceFromContext();
}
