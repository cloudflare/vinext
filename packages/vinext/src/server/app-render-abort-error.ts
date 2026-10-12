export function isAppRenderAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = Reflect.get(error, "name");
  return name === "AbortError" || name === "ResponseAborted";
}
