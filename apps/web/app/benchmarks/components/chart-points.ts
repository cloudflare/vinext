export function visibleMarkerMask(
  values: readonly (number | null)[],
  formatValue: (value: number) => string = String,
): boolean[] {
  const displayedValues = values.map((value) => (value === null ? null : formatValue(value)));

  return displayedValues.map(
    (value, index) =>
      value !== null &&
      (displayedValues[index - 1] !== value || displayedValues[index + 1] !== value),
  );
}
