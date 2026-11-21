/**
 * Whether the response-stage props select an App page's own document or RSC
 * payload, the two parts Next.js keeps in one entry, rather than a variant.
 */
export function isCanonicalAppPage(responseStageProps: unknown, isRscRequest: boolean): boolean {
  return (
    responseStageProps !== null &&
    typeof responseStageProps === "object" &&
    Reflect.get(responseStageProps, "kind") === "app-page" &&
    Reflect.get(responseStageProps, "isRscRequest") === isRscRequest &&
    // A rewrite's target is in the props that key the entry, so a rewritten
    // request reads its page's parts as a direct one does.
    (Reflect.get(responseStageProps, "matchKind") === "request" ||
      Reflect.get(responseStageProps, "matchKind") === "resolved") &&
    // A document always renders the whole page.
    (!isRscRequest || Reflect.get(responseStageProps, "renderMode") === "navigation") &&
    Reflect.get(responseStageProps, "interceptionContext") === null &&
    Reflect.get(responseStageProps, "interceptionId") === null &&
    Reflect.get(responseStageProps, "mountedSlotsHeader") === null
  );
}
