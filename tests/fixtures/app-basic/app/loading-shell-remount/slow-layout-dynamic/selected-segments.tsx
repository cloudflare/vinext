"use client";

import { useSelectedLayoutSegments } from "next/navigation";

export function SelectedSegments() {
  return <p id="selected-segments">{useSelectedLayoutSegments().join("/")}</p>;
}
