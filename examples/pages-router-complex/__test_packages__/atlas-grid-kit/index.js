// A table kit that ships its own CSS module. Its package.json lists only CSS
// under `sideEffects`, an array rather than a boolean.
import { createElement } from "react";

import styles from "./grid-kit.module.css";

export const GridTable = ({ columns, rows, testId }) =>
  createElement(
    "table",
    { className: styles.table, "data-testid": testId },
    createElement(
      "thead",
      null,
      createElement(
        "tr",
        null,
        columns.map((column) => createElement("th", { key: column }, column)),
      ),
    ),
    createElement(
      "tbody",
      null,
      rows.map((row, rowIndex) =>
        createElement(
          "tr",
          { key: rowIndex },
          row.map((cell, cellIndex) => createElement("td", { key: cellIndex }, cell)),
        ),
      ),
    ),
  );

export const sortRows = (rows, columnIndex) =>
  [...rows].sort((a, b) => String(a[columnIndex]).localeCompare(String(b[columnIndex])));
