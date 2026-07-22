import React from "react";
import { clientRef } from "./client-component";

export const contentType = "image/png";
const cachedNoop = React.cache(() => null);

function noopCall(value: unknown) {
  return value;
}

export default function sitemap() {
  // Keep the variable from being tree-shaken, matching the upstream fixture.
  noopCall(clientRef);
  cachedNoop();
  return [];
}
