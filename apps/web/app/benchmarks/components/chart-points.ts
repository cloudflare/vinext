export function visibleMarkerMask(values: readonly (number | null)[]): boolean[] {
  return values.map(
    (value, index) =>
      value !== null && (values[index - 1] !== value || values[index + 1] !== value),
  );
}
