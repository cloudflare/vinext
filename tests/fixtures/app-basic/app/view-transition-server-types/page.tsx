import { addTransitionType } from "react";

// Server component importing addTransitionType, which React's react-server
// entry does not export: vinext's no-op fallback keeps it callable.
export default function ViewTransitionServerTypesPage() {
  return <p data-testid="vt-server-add-transition-type">{typeof addTransitionType}</p>;
}
