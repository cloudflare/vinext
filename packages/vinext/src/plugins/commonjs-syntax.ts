// `require` as a whole identifier followed, through closing parentheses, by a
// call, an optional call, or a comment before either.
const COMMONJS_REQUIRE_CALL_RE = /(?<![\w$])require(?![\w$])[\s)]*(?:\/[*/]|\(|\?\.)/;

// `module` / `exports` as a whole identifier (not a property name after a
// single `.`, while a `...` spread still counts) followed, through closing
// parentheses, by a member access or a comment before one.
const COMMONJS_MEMBER_BASE_RE =
  /(?<![\w$]|(?<!\.)\.)(?:module|exports)(?![\w$])[\s)]*(?:\/[*/]|\??\.|\[)/;

/**
 * Conservative source-level superset of what vite-plugin-commonjs rewrites,
 * as a transform `filter.code.include` list (a module matches when any
 * pattern does; strings match as substrings).
 *
 * Its analyzer only acts on calls whose callee is the identifier `require` and
 * on assignments to a member of the identifiers `module` / `exports`, and the
 * transform returns nothing when neither is present. Text inside strings or
 * comments can produce false positives (the module is then analyzed as
 * before), and identifiers written with unicode escapes are never ruled out.
 */
export const COMMONJS_SYNTAX_CODE_FILTER = [
  COMMONJS_REQUIRE_CALL_RE,
  "\\u",
  COMMONJS_MEMBER_BASE_RE,
];

/** Whether `code` passes {@link COMMONJS_SYNTAX_CODE_FILTER}. */
export function mayContainCommonJsSyntax(code: string): boolean {
  return COMMONJS_SYNTAX_CODE_FILTER.some((pattern) =>
    typeof pattern === "string" ? code.includes(pattern) : pattern.test(code),
  );
}
