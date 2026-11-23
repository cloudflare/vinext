import { CHART_ROWS } from "./chart-data";
import { formatCount } from "./format-count";
import { Tag } from "./tag";
import styles from "./chart-panel.module.css";

export function ChartPanel() {
  return (
    <section data-marker="marker-chart-panel">
      <Tag className={styles.chartTag} probe="chart-tag">
        {CHART_ROWS[0]!.label}
      </Tag>
      <p>{formatCount(CHART_ROWS.length)}</p>
    </section>
  );
}
