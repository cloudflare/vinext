import React from "react";
import type { BeforeInteractiveInlineScript } from "./before-interactive-context.js";
import type { ScriptProps } from "./script.js";

export type DocumentScriptRegistration =
  | { kind: "beforeInteractive"; script: BeforeInteractiveInlineScript }
  | { kind: "client"; script: ScriptProps };

export type RegisterDocumentScript = (registration: DocumentScriptRegistration) => void;

export const DocumentScriptContext = React.createContext<RegisterDocumentScript | null>(null);

export function useDocumentScriptRegister(): RegisterDocumentScript | null {
  return React.useContext(DocumentScriptContext);
}
