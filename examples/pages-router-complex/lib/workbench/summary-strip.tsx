import { formatCount } from "atlas-legacy-format";

import styles from "./panel.module.css";

/** Ledger and roster share this strip. */
export const SummaryStrip = ({ figures }: { figures: Record<string, number> }) => (
  <aside className={styles.panel} data-testid="summary-strip">
    <p className={styles.panelTitle}>Summary</p>
    <dl>
      {Object.entries(figures).map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{formatCount(value)}</dd>
        </div>
      ))}
    </dl>
  </aside>
);
