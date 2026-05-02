import React from "react";

export const ScriptNonceContext = React.createContext<string | undefined>(undefined);

export function ScriptNonceProvider(
  props: React.PropsWithChildren<{
    nonce?: string;
  }>,
): React.ReactElement {
  return React.createElement(ScriptNonceContext.Provider, { value: props.nonce }, props.children);
}

export function withScriptNonce(element: React.ReactElement, nonce?: string): React.ReactElement {
  if (!nonce) {
    return element;
  }

  return React.createElement(ScriptNonceProvider, { nonce }, element);
}

export function useScriptNonce(): string | undefined {
  return React.useContext(ScriptNonceContext);
}
