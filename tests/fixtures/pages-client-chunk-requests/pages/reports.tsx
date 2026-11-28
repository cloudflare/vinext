import { ChartPanel } from "../lib/chart-panel";
import { TablePanel } from "../lib/table-panel";

// The one page that renders both panels.
export default function Reports() {
  return (
    <main data-page="reports">
      <ChartPanel />
      <TablePanel />
    </main>
  );
}
