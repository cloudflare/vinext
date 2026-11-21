import { formatMinutes } from "../format/durations";

/**
 * Only ever loaded on demand. Shares the duration helper that roster,
 * dispatch and inventory import statically.
 */
export const diffSchedules = (
  before: readonly number[],
  after: readonly number[],
): string[] =>
  before.map((minutes, index) => {
    const delta = (after[index] ?? minutes) - minutes;
    return `${delta >= 0 ? "+" : "-"}${formatMinutes(Math.abs(delta))}`;
  });
