import type { ReactElement } from "react";

type Cell = string | number;

export declare const GridTable: (props: {
  columns: readonly string[];
  rows: readonly (readonly Cell[])[];
  testId?: string;
}) => ReactElement;

export declare const sortRows: <Row extends readonly Cell[]>(
  rows: readonly Row[],
  columnIndex: number,
) => Row[];
