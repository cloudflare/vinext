import { TablePanel } from "../lib/table-panel";

// Shares the table panel with /reports.
export default function Invoices() {
  return (
    <main data-page="invoices">
      <TablePanel />
    </main>
  );
}
