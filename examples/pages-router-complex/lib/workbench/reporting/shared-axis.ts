/** The trend chart and the breakdown table, both lazy, share this scale. */
export const axisTicks = (max: number, count = 4): number[] =>
  Array.from({ length: count + 1 }, (_, index) => Math.round((max / count) * index));

export const scaleTo = (value: number, max: number, span = 100): number =>
  max === 0 ? 0 : Math.round((value / max) * span);
