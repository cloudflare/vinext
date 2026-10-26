/** What /esm-dependency-require in cf-app-basic renders in dev and in a build. */
export const ESM_DEPENDENCY_REQUIRE_VALUES: Record<string, string> = {
  joined: "a/b",
  esm: "default named",
  cjs: "cjs named",
  shim: "function",
  json: "json",
  optional: "fallback",
  nestedOptional: "fallback",
  throws: "throws on load",
  configured: "configured",
  browserOnly: "not evaluated",
  shadowed: "local ./exports.js",
};
