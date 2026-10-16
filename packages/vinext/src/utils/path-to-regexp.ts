// Derived from path-to-regexp 6.3.0:
// https://github.com/pillarjs/path-to-regexp/tree/v6.3.0
//
// The MIT License (MIT)
// Copyright (c) 2014 Blake Embrey (hello@blakeembrey.com)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

export type PathToken = string | PathKey;

export type PathKey = {
  name: string | number;
  prefix: string;
  suffix: string;
  pattern: string;
  modifier: string;
};

type LexerToken = {
  type: "MODIFIER" | "ESCAPED_CHAR" | "OPEN" | "CLOSE" | "NAME" | "PATTERN" | "CHAR" | "END";
  index: number;
  value: string;
};

function lexer(value: string): LexerToken[] {
  const tokens: LexerToken[] = [];
  let index = 0;

  while (index < value.length) {
    const character = value[index];
    if (character === "*" || character === "+" || character === "?") {
      tokens.push({ type: "MODIFIER", index, value: value[index++] });
      continue;
    }
    if (character === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: index++, value: value[index++] });
      continue;
    }
    if (character === "{") {
      tokens.push({ type: "OPEN", index, value: value[index++] });
      continue;
    }
    if (character === "}") {
      tokens.push({ type: "CLOSE", index, value: value[index++] });
      continue;
    }
    if (character === ":") {
      let name = "";
      let nameEnd = index + 1;
      while (nameEnd < value.length) {
        const code = value.charCodeAt(nameEnd);
        if (
          (code >= 48 && code <= 57) ||
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122) ||
          code === 95
        ) {
          name += value[nameEnd++];
          continue;
        }
        break;
      }
      if (!name) throw new TypeError(`Missing parameter name at ${index}`);
      tokens.push({ type: "NAME", index, value: name });
      index = nameEnd;
      continue;
    }
    if (character === "(") {
      let depth = 1;
      let pattern = "";
      let patternEnd = index + 1;
      if (value[patternEnd] === "?") {
        throw new TypeError(`Pattern cannot start with "?" at ${patternEnd}`);
      }
      while (patternEnd < value.length) {
        if (value[patternEnd] === "\\") {
          pattern += value[patternEnd++] + value[patternEnd++];
          continue;
        }
        if (value[patternEnd] === ")") {
          depth--;
          if (depth === 0) {
            patternEnd++;
            break;
          }
        } else if (value[patternEnd] === "(") {
          depth++;
          if (value[patternEnd + 1] !== "?") {
            throw new TypeError(`Capturing groups are not allowed at ${patternEnd}`);
          }
        }
        pattern += value[patternEnd++];
      }
      if (depth) throw new TypeError(`Unbalanced pattern at ${index}`);
      if (!pattern) throw new TypeError(`Missing pattern at ${index}`);
      tokens.push({ type: "PATTERN", index, value: pattern });
      index = patternEnd;
      continue;
    }
    tokens.push({ type: "CHAR", index, value: value[index++] });
  }

  tokens.push({ type: "END", index, value: "" });
  return tokens;
}

export type ParsePathPatternOptions = {
  /** Characters a default param cannot contain. path-to-regexp defaults to `/#?`. */
  delimiter?: string;
};

export function parsePathPattern(
  value: string,
  options: ParsePathPatternOptions = {},
): PathToken[] {
  const tokens = lexer(value);
  const result: PathToken[] = [];
  const prefixes = "./";
  const delimiter = options.delimiter ?? "/#?";
  const delimiterClass = `[^${escapeRegex(delimiter)}]`;
  let key = 0;
  let index = 0;
  let path = "";

  const tryConsume = (type: LexerToken["type"]): string | undefined => {
    if (index < tokens.length && tokens[index].type === type) {
      return tokens[index++].value;
    }
    return undefined;
  };

  const mustConsume = (type: LexerToken["type"]): string => {
    const consumed = tryConsume(type);
    if (consumed !== undefined) return consumed;
    const next = tokens[index];
    throw new TypeError(`Unexpected ${next.type} at ${next.index}, expected ${type}`);
  };

  const consumeText = (): string => {
    let text = "";
    let consumed: string | undefined;
    while ((consumed = tryConsume("CHAR") ?? tryConsume("ESCAPED_CHAR")) !== undefined) {
      text += consumed;
    }
    return text;
  };

  const containsDelimiter = (text: string): boolean => {
    for (const character of delimiter) {
      if (text.includes(character)) return true;
    }
    return false;
  };

  const defaultPattern = (prefix: string): string => {
    const previous = result[result.length - 1];
    const previousText = prefix || (typeof previous === "string" ? previous : "");
    if (previous && !previousText) {
      const name = typeof previous === "string" ? previous : previous.name;
      throw new TypeError(`Must have text between two parameters, missing text after "${name}"`);
    }
    if (!previousText || containsDelimiter(previousText)) return `${delimiterClass}+?`;
    return `(?:(?!${escapeRegex(previousText)})${delimiterClass})+?`;
  };

  while (index < tokens.length) {
    const character = tryConsume("CHAR");
    const name = tryConsume("NAME");
    const pattern = tryConsume("PATTERN");
    if (name !== undefined || pattern !== undefined) {
      let prefix = character ?? "";
      if (!prefixes.includes(prefix)) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name ?? key++,
        prefix,
        suffix: "",
        pattern: pattern ?? defaultPattern(prefix),
        modifier: tryConsume("MODIFIER") ?? "",
      });
      continue;
    }

    const text = character ?? tryConsume("ESCAPED_CHAR");
    if (text !== undefined) {
      path += text;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    if (tryConsume("OPEN") !== undefined) {
      const prefix = consumeText();
      const groupName = tryConsume("NAME") ?? "";
      const groupPattern = tryConsume("PATTERN") ?? "";
      const suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: groupName || (groupPattern ? key++ : ""),
        pattern: groupName && !groupPattern ? defaultPattern(prefix) : groupPattern,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") ?? "",
      });
      continue;
    }
    mustConsume("END");
  }

  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}

export function normalizePathTokens(tokens: PathToken[]): PathToken[] {
  return tokens.map((token) => {
    if (
      typeof token === "object" &&
      (token.modifier === "*" || token.modifier === "+") &&
      token.prefix === "" &&
      token.suffix === ""
    ) {
      return { ...token, prefix: "/" };
    }
    return token;
  });
}

/**
 * path-to-regexp's `tokensToRegexp` with `strict: true`, without the closing
 * `$`. Callers append the ending their Next.js matcher uses.
 */
export function pathTokensToRegExpSource(tokens: PathToken[]): string {
  let route = "^";

  for (const token of tokens) {
    if (typeof token === "string") {
      route += escapeRegex(token);
      continue;
    }

    const prefix = escapeRegex(token.prefix);
    const suffix = escapeRegex(token.suffix);
    if (token.pattern) {
      if (prefix || suffix) {
        if (token.modifier === "+" || token.modifier === "*") {
          const optional = token.modifier === "*" ? "?" : "";
          route += `(?:${prefix}((?:${token.pattern})(?:${suffix}${prefix}(?:${token.pattern}))*)${suffix})${optional}`;
        } else {
          route += `(?:${prefix}(${token.pattern})${suffix})${token.modifier}`;
        }
      } else {
        if (token.modifier === "+" || token.modifier === "*") {
          throw new TypeError(`Can not repeat "${token.name}" without a prefix and suffix`);
        }
        route += `(${token.pattern})${token.modifier}`;
      }
    } else {
      route += `(?:${prefix}${suffix})${token.modifier}`;
    }
  }

  return route;
}
