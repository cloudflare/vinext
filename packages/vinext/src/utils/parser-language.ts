import { stripViteModuleQuery } from "./path.js";

export function parserLanguageForModule(id: string): "js" | "jsx" | "ts" | "tsx" {
  const cleanId = stripViteModuleQuery(id).toLowerCase();
  if (cleanId.endsWith(".tsx")) return "tsx";
  if (cleanId.endsWith(".ts") || cleanId.endsWith(".mts") || cleanId.endsWith(".cts")) {
    return "ts";
  }
  return "jsx";
}
