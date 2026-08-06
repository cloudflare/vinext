export type PagesRouterComponentsMap = Record<
  string,
  { __appRouter: true } | Record<string, unknown>
>;

const COMPONENTS_KEY = Symbol.for("vinext.pagesRouter.components");
type GlobalWithComponents = typeof globalThis & {
  [COMPONENTS_KEY]?: PagesRouterComponentsMap;
};

export function getPagesRouterComponentsMap(): PagesRouterComponentsMap {
  const globalState = globalThis as GlobalWithComponents;
  let components = globalState[COMPONENTS_KEY];
  if (!components) {
    components = {};
    globalState[COMPONENTS_KEY] = components;
  }
  return components;
}
