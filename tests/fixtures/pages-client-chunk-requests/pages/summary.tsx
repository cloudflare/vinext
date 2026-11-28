import { ChartPanel } from "../lib/chart-panel";

// Shares the chart panel with /reports.
export default function Summary() {
  return (
    <main data-page="summary">
      <ChartPanel />
    </main>
  );
}
