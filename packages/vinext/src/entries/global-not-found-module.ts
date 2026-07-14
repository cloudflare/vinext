/**
 * Stable virtual module id for the optional App Router global-not-found module.
 *
 * Generated entries import this static id instead of embedding the discovered
 * filesystem path in generated JavaScript. The vinext resolver maps the id to
 * the real file, so arbitrary valid paths remain data handled by Vite rather
 * than becoming part of a generated code string.
 */
export const GLOBAL_NOT_FOUND_MODULE_ID = "virtual:vinext-global-not-found";

export type GlobalNotFoundModuleId = typeof GLOBAL_NOT_FOUND_MODULE_ID;

export function selectGlobalNotFoundModuleId(
  modulePath: string | null | undefined,
): GlobalNotFoundModuleId | null {
  return modulePath ? GLOBAL_NOT_FOUND_MODULE_ID : null;
}
