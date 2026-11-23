import { formatCount } from "./format-count";
import { TABLE_ROWS } from "./table-data";
import { Tag } from "./tag";
import styles from "./table-panel.module.css";

export function TablePanel() {
  return (
    <section data-marker="marker-table-panel">
      <Tag className={styles.tableTag} probe="table-tag">
        {TABLE_ROWS[0]!.label}
      </Tag>
      <p>{formatCount(TABLE_ROWS.length)}</p>
    </section>
  );
}
