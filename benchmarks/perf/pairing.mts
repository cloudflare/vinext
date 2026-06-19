export const DEFAULT_PAIRED_ROUNDS = 6;

export function pairedRevisionOrder(round: number): Array<"base" | "head"> {
  return round % 2 === 0 ? ["base", "head"] : ["head", "base"];
}
