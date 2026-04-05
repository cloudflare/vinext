"use client";

import { useSelectedLayoutSegment, useSelectedLayoutSegments } from "next/navigation";

/**
 * Test component that displays the selected layout segments.
 * Used to verify that useSelectedLayoutSegments() returns segments
 * relative to the layout where it's rendered, not all pathname segments.
 * Also tests parallelRoutesKey for parallel slot segment queries.
 */
export function SegmentDisplay() {
  const segments = useSelectedLayoutSegments();
  const segment = useSelectedLayoutSegment();
  const teamSegments = useSelectedLayoutSegments("team");
  const teamSegment = useSelectedLayoutSegment("team");
  const analyticsSegments = useSelectedLayoutSegments("analytics");

  return (
    <div data-testid="segment-display">
      <span data-testid="segments">{JSON.stringify(segments)}</span>
      <span data-testid="segment">{segment ?? "null"}</span>
      <span data-testid="team-segments">{JSON.stringify(teamSegments)}</span>
      <span data-testid="team-segment">{teamSegment ?? "null"}</span>
      <span data-testid="analytics-segments">{JSON.stringify(analyticsSegments)}</span>
    </div>
  );
}
