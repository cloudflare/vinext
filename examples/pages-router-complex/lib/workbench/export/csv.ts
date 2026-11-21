const quote = (cell: string): string =>
  /[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;

export const toCsv = (rows: readonly (readonly string[])[]): string =>
  rows.map((row) => row.map(quote).join(",")).join("\n");
