/**
 * Param substitution for next.config.js `headers()` keys and values.
 *
 * Next.js compiles each header key and value with `compileNonPath`: only
 * `:name` markers for captured params are substituted, every other
 * path-to-regexp metacharacter stays literal, repeated params are joined with
 * their template prefix and suffix, and params are inserted verbatim (no
 * encoding or validation).
 *
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/shared/lib/router/utils/prepare-destination.ts
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/shared/lib/router/utils/route-match-utils.ts
 */

import { parsePathPattern } from "../utils/path-to-regexp.js";

/**
 * Params captured by a header rule: path-to-regexp source params (`*`/`+`
 * params are arrays) merged with Next.js `matchHas` captures. A has capture
 * can be `undefined` when its named group did not participate in the match.
 */
export type HeaderParams = Record<string, string | string[] | undefined>;

/**
 * Substitute `params` into a header key or value like Next.js's
 * `compileNonPath`. Throws where Next.js throws: a repeated param referenced
 * without `*`/`+`, an `undefined` has capture, or a template path-to-regexp
 * cannot parse.
 */
export function compileHeaderParamTemplate(value: string, params: HeaderParams): string {
  if (!value.includes(":")) return value;

  // The escaped and parsed template depends only on the template and the
  // param names, so build it once per pair rather than on every request.
  const keys = Object.keys(params);
  // JSON keeps the key unambiguous: a config template may itself contain any
  // delimiter, including `\0`.
  const cacheKey = JSON.stringify([value, keys]);
  let compiled = _compiledTemplateCache.get(cacheKey);
  if (!compiled) {
    try {
      compiled = { compile: compileTemplate(value, keys) };
    } catch (error) {
      compiled = { error };
    }
    _compiledTemplateCache.set(cacheKey, compiled);
  }
  if ("error" in compiled) throw compiled.error;
  return compiled.compile(params);
}

type CompiledTemplate = { compile: (params: HeaderParams) => string } | { error: unknown };

const _compiledTemplateCache = new Map<string, CompiledTemplate>();

function compileTemplate(value: string, keys: string[]): (params: HeaderParams) => string {
  for (const key of keys) {
    if (value.includes(`:${key}`)) {
      value = value
        .replace(new RegExp(`:${key}\\*`, "g"), `:${key}--ESCAPED_PARAM_ASTERISKS`)
        .replace(new RegExp(`:${key}\\?`, "g"), `:${key}--ESCAPED_PARAM_QUESTION`)
        .replace(new RegExp(`:${key}\\+`, "g"), `:${key}--ESCAPED_PARAM_PLUS`)
        .replace(new RegExp(`:${key}(?!\\w)`, "g"), `--ESCAPED_PARAM_COLON${key}`);
    }
  }
  value = value
    .replace(/(:|\*|\?|\+|\(|\)|\{|\})/g, "\\$1")
    .replace(/--ESCAPED_PARAM_PLUS/g, "+")
    .replace(/--ESCAPED_PARAM_COLON/g, ":")
    .replace(/--ESCAPED_PARAM_QUESTION/g, "?")
    .replace(/--ESCAPED_PARAM_ASTERISKS/g, "*");

  // The value needs to start with a forward slash to be compiled correctly.
  const compiler = safeCompile(`/${value}`);
  return (params) => compiler(params).slice(1);
}

const PARAM_SEPARATOR = "_NEXTSEP_";

// Next.js's `safeCompile` retries templates with adjacent params
// (`:a:b`) after inserting a separator path-to-regexp accepts.
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/lib/route-pattern-normalizer.ts
function safeCompile(route: string): (params: HeaderParams) => string {
  const needsNormalization = /\/\(\.{1,3}\):[^/\s]+/.test(route) || ADJACENT_PARAMS_RE.test(route);
  const routeToUse = needsNormalization ? normalizeAdjacentParameters(route) : route;
  try {
    const compiler = compile(routeToUse);
    return needsNormalization ? (params) => stripNormalizedSeparators(compiler(params)) : compiler;
  } catch (error) {
    if (needsNormalization) throw error;
    try {
      const compiler = compile(normalizeAdjacentParameters(route));
      return (params) => stripNormalizedSeparators(compiler(params));
    } catch {
      throw error;
    }
  }
}

const ADJACENT_PARAMS_RE = /:[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z_][a-zA-Z0-9_]*/;

function normalizeAdjacentParameters(route: string): string {
  return route
    .replace(/(\([^)]*\)):([^/\s]+)/g, `$1${PARAM_SEPARATOR}:$2`)
    .replace(/:([^:/\s)]+)(?=:)/g, `:$1${PARAM_SEPARATOR}`);
}

function stripNormalizedSeparators(pathname: string): string {
  return pathname.replace(new RegExp(`\\)${PARAM_SEPARATOR}`, "g"), ")");
}

// path-to-regexp 6.3.0 `compile` with `validate: false` and the default
// identity `encode`.
function compile(route: string): (params: HeaderParams) => string {
  const tokens = parsePathPattern(route);
  return (params) => {
    let path = "";
    for (const token of tokens) {
      if (typeof token === "string") {
        path += token;
        continue;
      }
      const value = params[token.name];
      const optional = token.modifier === "?" || token.modifier === "*";
      const repeat = token.modifier === "*" || token.modifier === "+";
      if (Array.isArray(value)) {
        if (!repeat) {
          throw new TypeError(`Expected "${token.name}" to not repeat, but got an array`);
        }
        if (value.length === 0) {
          if (optional) continue;
          throw new TypeError(`Expected "${token.name}" to not be empty`);
        }
        for (const segment of value) path += token.prefix + segment + token.suffix;
        continue;
      }
      if (typeof value === "string") {
        path += token.prefix + value + token.suffix;
        continue;
      }
      if (optional) continue;
      throw new TypeError(`Expected "${token.name}" to be ${repeat ? "an array" : "a string"}`);
    }
    return path;
  };
}

// Node's `setHeader` checks. Next.js fails the request when a substituted
// key or value breaks them; Web `Headers` would throw (CR/LF, NUL, non-Latin-1)
// or accept other control characters.
const HTTP_TOKEN_RE = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const INVALID_HEADER_VALUE_CHAR_RE = /[^\t\x20-\x7e\x80-\xff]/;

/** Whether a substituted header pair can be sent as a response header. */
export function isValidHeaderPair(key: string, value: string): boolean {
  return HTTP_TOKEN_RE.test(key) && !INVALID_HEADER_VALUE_CHAR_RE.test(value);
}
