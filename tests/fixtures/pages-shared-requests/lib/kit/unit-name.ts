// `_app` imports from this module's barrel but does not use it. The two
// indexes do.
export function unitName(value: number): string {
  return `marker-unit-name:${value % 7}`;
}
