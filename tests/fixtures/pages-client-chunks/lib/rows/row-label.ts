// A small module that both large modules and the home page import.
export function rowLabel(kind: string, index: number): string {
  return `${kind} row ${index}`;
}
