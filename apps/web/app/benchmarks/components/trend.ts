export function rollingMedian(
  values: readonly (number | null)[],
  windowSize: number,
): (number | null)[] {
  assertWindowSize(windowSize);

  const observations: number[] = [];
  return values.map((value) => {
    if (value === null) return null;
    observations.push(value);
    if (observations.length < windowSize) return null;

    const window = observations.slice(-windowSize).toSorted((a, b) => a - b);
    const middle = Math.floor(window.length / 2);
    return window.length % 2 === 0 ? (window[middle - 1] + window[middle]) / 2 : window[middle];
  });
}

export function hasRollingMedian(values: readonly (number | null)[], windowSize: number): boolean {
  assertWindowSize(windowSize);
  return values.filter((value) => value !== null).length >= windowSize;
}

function assertWindowSize(windowSize: number): void {
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new Error("Rolling median window must be a positive integer");
  }
}
