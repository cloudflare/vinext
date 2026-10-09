/**
 * `__NEXT_DATA__.dynamicIds` lists the next/dynamic modules a Pages Router
 * render used, so the browser can load them before hydrating. The ids are
 * only known once the body has rendered, but the document shell (and its
 * `__NEXT_DATA__` script) is built around the body stream. The script
 * therefore carries a placeholder `dynamicIds` property, which is filled in
 * (or dropped when no dynamic component rendered, as in Next.js) after the
 * body render.
 *
 * Known limitation: a custom `_document` that renders `<NextScript />` before
 * `<Main />` puts `__NEXT_DATA__` in the streamed document prefix, which is
 * filled once the shell has rendered, so a dynamic() inside a user Suspense
 * boundary that resolves later is not listed (Next.js renders the whole body
 * first). Dev page renders (not dev error pages) buffer the body first, so
 * they are exact.
 */

/**
 * Value for `dynamicIds` in a `__NEXT_DATA__` payload whose ids are filled in
 * later. It must be the payload's last property: the fill matches the last
 * occurrence, which user data serialized earlier in the payload can't shadow.
 */
export const DEFERRED_PAGES_DYNAMIC_IDS = "__VINEXT_DYNAMIC_IDS__";

const PLACEHOLDER_PROPERTY = `,"dynamicIds":"${DEFERRED_PAGES_DYNAMIC_IDS}"`;
const NEXT_DATA_SCRIPT_START = '<script id="__NEXT_DATA__"';

export function fillPagesDynamicIds(
  html: string,
  dynamicIds: readonly string[] | undefined,
  safeJsonStringify: (value: unknown) => string,
): string {
  // Only inside the __NEXT_DATA__ script, so page content elsewhere in the
  // document (e.g. a JSON-LD <Head> script) can't be mistaken for it.
  const scriptStart = html.indexOf(NEXT_DATA_SCRIPT_START);
  if (scriptStart === -1) return html;
  const scriptEnd = html.indexOf("</script>", scriptStart);
  const index = html.lastIndexOf(PLACEHOLDER_PROPERTY, scriptEnd === -1 ? html.length : scriptEnd);
  if (index < scriptStart) return html;
  const property = dynamicIds ? `,"dynamicIds":${safeJsonStringify(dynamicIds)}` : "";
  return html.slice(0, index) + property + html.slice(index + PLACEHOLDER_PROPERTY.length);
}
