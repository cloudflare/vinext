"use client";

import { useSelectedLayoutSegment } from "next/navigation";

export function AsideSegment() {
  return (
    <p data-testid="owner-params-aside-segment">{String(useSelectedLayoutSegment("aside"))}</p>
  );
}
