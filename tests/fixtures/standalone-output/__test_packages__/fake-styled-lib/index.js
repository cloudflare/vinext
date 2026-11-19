// Like @mui/material importing @emotion/react: the engine is an optional peer
// dependency, never a dependency, so only tracing this import ships it.
import { engineName } from "fake-style-engine";

export function styledLabel(text) {
  return `${text} (styled by ${engineName})`;
}
