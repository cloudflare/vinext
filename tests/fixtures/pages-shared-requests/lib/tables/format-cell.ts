// A small helper that every section of both tables calls.
export function formatCell(value: string): string {
  return `marker-format-cell:${value.trim()}`;
}
