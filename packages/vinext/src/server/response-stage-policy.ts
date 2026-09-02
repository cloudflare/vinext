import { mergeVaryHeader } from "./middleware-response-headers.js";

/** Apply request-stage cache policy before response-stage admission. */
export function applyResponseStagePolicyHeaders(
  headers: Headers,
  policyHeaders: ReadonlyArray<readonly [string, string]> | null | undefined,
): void {
  for (const [name, value] of policyHeaders ?? []) {
    if (name.toLowerCase() === "vary") {
      mergeVaryHeader(headers, value);
    } else {
      headers.set(name, value);
    }
  }
}

/** Replace transported Vary fields with the effective request-stage value. */
export function withResponseStageVary(
  policyHeaders: ReadonlyArray<readonly [string, string]> | null | undefined,
  vary: string | null | undefined,
): Array<[string, string]> | null {
  const result: Array<[string, string]> = [];
  const varyHeaders = new Headers();
  for (const [name, value] of policyHeaders ?? []) {
    if (name.toLowerCase() === "vary") mergeVaryHeader(varyHeaders, value);
    else result.push([name, value]);
  }
  if (vary) mergeVaryHeader(varyHeaders, vary);
  const effectiveVary = varyHeaders.get("Vary");
  if (effectiveVary) result.push(["Vary", effectiveVary]);
  return result.length > 0 ? result : null;
}
