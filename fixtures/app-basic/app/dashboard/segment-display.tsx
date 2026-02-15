"use client";

import { useSelectedLayoutSegment, useSelectedLayoutSegments } from "next/navigation";

/**
 * Test component that displays the selected layout segments.
 * Used to verify that useSelectedLayoutSegments() returns segments
 * relative to the layout where it's rendered, not all pathname segments.
 */
export function SegmentDisplay() {
  const segments = useSelectedLayoutSegments();
  const segment = useSelectedLayoutSegment();

  return (
    <div data-testid="segment-display">
      <span data-testid="segments">{JSON.stringify(segments)}</span>
      <span data-testid="segment">{segment ?? "null"}</span>
    </div>
  );
}
