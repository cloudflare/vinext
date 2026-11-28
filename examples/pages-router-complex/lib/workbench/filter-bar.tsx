import { useState } from "react";

import styles from "./panel.module.css";

/** Roster and dispatch share this filter bar. */
export const FilterBar = ({
  options,
  onChange,
}: {
  options: readonly string[];
  onChange: (value: string) => void;
}) => {
  const [value, setValue] = useState(options[0] ?? "");
  return (
    <div className={styles.panel} data-testid="filter-bar">
      <p className={styles.panelTitle}>Filter</p>
      <select
        data-testid="filter-select"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
};
