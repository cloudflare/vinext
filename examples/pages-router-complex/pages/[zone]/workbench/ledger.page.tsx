import { ArrowGlyph, LedgerGlyph } from "atlas-glyphs";

import { DeskLayout } from "@atlas/workbench/desk-layout";
import { ExportMenu } from "@atlas/workbench/export-menu";
import { formatCents } from "@atlas/workbench/format/currency";
import { workbenchServerProps } from "@atlas/workbench/page-data";
import { StatusPill } from "@atlas/workbench/status-pill";
import { SummaryStrip } from "@atlas/workbench/summary-strip";

import styles from "./desk.module.css";

const ENTRIES = [
  ["INV-1001", 129900],
  ["INV-1002", 4550],
  ["INV-1003", 87125],
] as const;

const LedgerDesk = () => (
  <DeskLayout desk="ledger" title="Ledger">
    <div className={styles.columns}>
      <SummaryStrip figures={{ entries: ENTRIES.length, cents: 221575 }} />
      <ul data-testid="ledger-entries">
        {ENTRIES.map(([id, cents]) => (
          <li key={id}>
            <LedgerGlyph /> {id} <ArrowGlyph /> {formatCents(cents)}
          </li>
        ))}
      </ul>
    </div>
    <StatusPill label="ledger" />
    <ExportMenu rows={ENTRIES.map(([id, cents]) => [id, formatCents(cents)])} />
  </DeskLayout>
);

export const getServerSideProps = workbenchServerProps("ledger");

export default LedgerDesk;
