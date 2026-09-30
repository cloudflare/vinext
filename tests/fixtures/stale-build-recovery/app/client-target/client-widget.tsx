"use client";

import { VERSION } from "../version";

export function ClientWidget() {
  return <p id="widget">CLIENT_WIDGET_MARKER {VERSION}</p>;
}
