import fs from "node:fs";

/**
 * Read and parse a JSON file, returning `null` if the file is missing,
 * unreadable, or contains invalid JSON.
 *
 * Pass `onError` to log/observe failures while still receiving `null`. The
 * callback is invoked for any thrown error from `readFileSync` or
 * `JSON.parse` (e.g. `ENOENT`, syntax errors).
 *
 * Callers that need a default value other than `null` should map the result:
 *   `readJsonFile<string[]>(p) ?? []`
 */
export function readJsonFile<T>(
  filePath: string,
  options?: { onError?: (err: unknown) => void },
): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    options?.onError?.(err);
    return null;
  }
}
