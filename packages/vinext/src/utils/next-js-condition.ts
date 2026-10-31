/** Whether a package.json `exports` or `imports` value uses the `next-js` condition. */
export function hasNextJsCondition(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.entries(value).some(([key, nested]) => key === "next-js" || hasNextJsCondition(nested))
  );
}
