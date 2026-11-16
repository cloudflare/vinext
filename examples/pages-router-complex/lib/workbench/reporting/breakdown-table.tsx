import { GridTable, sortRows } from "atlas-grid-kit";

import { StatusPill } from "../status-pill";

import { axisTicks } from "./shared-axis";

/**
 * Loaded through React.lazy. Shares the axis helper with the trend chart's
 * lazy chunk, the status pill with every desk, and the grid kit with the
 * inventory desk.
 */
const BreakdownTable = ({ rows }: { rows: readonly (readonly [string, number])[] }) => {
  const max = Math.max(...rows.map(([, value]) => value));
  return (
    <div data-testid="breakdown">
      <StatusPill label="breakdown" />
      <GridTable
        testId="breakdown-table"
        columns={["Desk", "Volume"]}
        rows={sortRows(rows, 0)}
      />
      <p>Scale: {axisTicks(max, 2).join(" / ")}</p>
    </div>
  );
};

export default BreakdownTable;
