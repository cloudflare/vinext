import { useState } from "react";

/**
 * Ledger, dispatch and inventory share this menu. The CSV encoder loads on
 * demand; the tools desk imports the same module statically.
 */
export const ExportMenu = ({ rows }: { rows: readonly (readonly string[])[] }) => {
  const [exported, setExported] = useState<string | null>(null);
  return (
    <div data-testid="export-menu">
      <button
        type="button"
        data-testid="export-csv"
        onClick={async () => {
          const { toCsv } = await import("./export/csv");
          setExported(toCsv(rows));
        }}
      >
        Export CSV
      </button>
      {exported !== null && <pre data-testid="export-output">{exported}</pre>}
    </div>
  );
};
