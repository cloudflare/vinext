import type { CloudflareInitOptions } from "../init-platform.js";
import {
  DEFAULT_IMAGES_BINDING,
  KV_NAMESPACE_ID_PLACEHOLDER,
  VINEXT_KV_CACHE_BINDING,
} from "./constants.js";
import type { WranglerConfigUpdateFacts } from "./types.js";

type TomlAssignment = {
  valueStart: number;
  valueEnd: number;
  value: string;
};

type TomlSection = {
  bodyStart: number;
  bodyEnd: number;
};

type TomlMultilineStringDelimiter = `"""` | "'''";

type TomlKeyToken = {
  name: string;
  end: number;
};

export type WranglerTomlConfigUpdate = WranglerConfigUpdateFacts & {
  code: string;
};

// This is not a general TOML editor. It only patches Wrangler fields owned by
// vinext init when their syntax can be updated in place without rewriting the
// user's config. Other owned shapes are rejected before mutation.
function stripTomlLineComment(line: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

function forEachTomlLine(
  code: string,
  callback: (line: string, lineStart: number, lineEnd: number) => void,
): void {
  let lineStart = 0;
  while (lineStart <= code.length) {
    const newline = code.indexOf("\n", lineStart);
    const lineEndWithoutNewline = newline === -1 ? code.length : newline;
    const lineEnd = newline === -1 ? code.length : newline + 1;
    callback(code.slice(lineStart, lineEndWithoutNewline), lineStart, lineEnd);
    if (newline === -1) break;
    lineStart = newline + 1;
  }
}

function updateTomlMultilineStringDelimiter(
  line: string,
  delimiter: TomlMultilineStringDelimiter | undefined,
): TomlMultilineStringDelimiter | undefined {
  let index = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let multilineDelimiter = delimiter;

  while (index < line.length) {
    if (multilineDelimiter) {
      if (multilineDelimiter === `"""` && line[index] === "\\") {
        index += 2;
        continue;
      }
      if (line.startsWith(multilineDelimiter, index)) {
        index += multilineDelimiter.length;
        multilineDelimiter = undefined;
        continue;
      }
      index++;
      continue;
    }

    const char = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      index++;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      index++;
      continue;
    }
    if (char === "#") break;
    if (line.startsWith(`"""`, index)) {
      multilineDelimiter = `"""`;
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      multilineDelimiter = "'''";
      index += 3;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index++;
      continue;
    }
    index++;
  }

  return multilineDelimiter;
}

function forEachTomlSyntaxLine(
  code: string,
  callback: (line: string, lineStart: number, lineEnd: number) => void,
): void {
  let multilineDelimiter: TomlMultilineStringDelimiter | undefined;
  forEachTomlLine(code, (line, lineStart, lineEnd) => {
    const startsInsideMultilineString = multilineDelimiter !== undefined;
    multilineDelimiter = updateTomlMultilineStringDelimiter(line, multilineDelimiter);
    if (!startsInsideMultilineString) callback(line, lineStart, lineEnd);
  });
}

function skipTomlWhitespace(source: string, index: number): number {
  let cursor = index;
  while (/\s/.test(source[cursor] ?? "")) cursor++;
  return cursor;
}

function readTomlKeyToken(source: string, start = 0): TomlKeyToken | undefined {
  const index = skipTomlWhitespace(source, start);
  const char = source[index];

  if (char === '"' || char === "'") {
    const delimiter = char === '"' ? `"""` : "'''";
    if (source.startsWith(delimiter, index)) return undefined;

    let escaped = false;
    for (let cursor = index + 1; cursor < source.length; cursor++) {
      const tokenChar = source[cursor];
      if (char === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (char === '"' && tokenChar === "\\") {
        escaped = true;
        continue;
      }
      if (tokenChar === char) {
        const value = parseTomlString(source.slice(index, cursor + 1));
        return value === undefined ? undefined : { name: value, end: cursor + 1 };
      }
    }
    return undefined;
  }

  const bare = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
  return bare ? { name: bare[0], end: index + bare[0].length } : undefined;
}

function parseDirectTomlKeyName(source: string): string | undefined {
  const key = readTomlKeyToken(source);
  if (!key) return undefined;
  return skipTomlWhitespace(source, key.end) === source.length ? key.name : undefined;
}

function parseFirstDottedTomlKeyName(source: string): string | undefined {
  const key = readTomlKeyToken(source);
  if (!key) return undefined;
  return source[skipTomlWhitespace(source, key.end)] === "." ? key.name : undefined;
}

function findTomlAssignmentInLine(
  line: string,
  name: string,
): { valueStart: number; valueEnd: number; value: string } | undefined {
  const key = readTomlKeyToken(line);
  if (!key || key.name !== name) return undefined;

  let valueStart = skipTomlWhitespace(line, key.end);
  if (line[valueStart] !== "=") return undefined;
  valueStart = skipTomlWhitespace(line, valueStart + 1);

  let valueEnd = line.length;
  while (valueEnd > valueStart && /\s/.test(line[valueEnd - 1])) valueEnd--;
  return {
    valueStart,
    valueEnd,
    value: line.slice(valueStart, valueEnd),
  };
}

function parseTomlHeader(
  line: string,
): { name: string; rawName: string; isArray: boolean } | undefined {
  const trimmed = stripTomlLineComment(line).trim();
  const match = trimmed.match(/^(\[\[?)\s*([^[\]]+?)\s*(\]\]?)$/);
  if (!match) return undefined;
  const isArray = match[1] === "[[";
  if (isArray !== (match[3] === "]]")) return undefined;
  const rawName = match[2];
  const name = parseDirectTomlKeyName(rawName) ?? rawName.trim();
  return { name, rawName, isArray };
}

function findFirstTomlSectionStart(code: string): number | undefined {
  let firstSectionStart: number | undefined;
  forEachTomlSyntaxLine(code, (line, lineStart) => {
    if (firstSectionStart !== undefined) return;
    if (parseTomlHeader(line)) firstSectionStart = lineStart;
  });
  return firstSectionStart;
}

function findTopLevelTomlAssignment(code: string, name: string): TomlAssignment | undefined {
  const topLevelEnd = findFirstTomlSectionStart(code) ?? code.length;
  let match: TomlAssignment | undefined;
  forEachTomlSyntaxLine(code.slice(0, topLevelEnd), (line, lineStart) => {
    if (match) return;
    const uncommented = stripTomlLineComment(line);
    const assignment = findTomlAssignmentInLine(uncommented, name);
    if (!assignment) return;
    match = {
      valueStart: lineStart + assignment.valueStart,
      valueEnd: lineStart + assignment.valueEnd,
      value: assignment.value,
    };
  });
  return match;
}

function hasTopLevelDottedKey(code: string, name: string): boolean {
  const topLevelEnd = findFirstTomlSectionStart(code) ?? code.length;
  let found = false;
  forEachTomlSyntaxLine(code.slice(0, topLevelEnd), (line) => {
    if (found) return;
    const uncommented = stripTomlLineComment(line);
    const key = readTomlKeyToken(uncommented);
    if (!key || key.name !== name) return;
    found = uncommented[skipTomlWhitespace(uncommented, key.end)] === ".";
  });
  return found;
}

function hasDottedTomlSectionHeader(code: string, name: string): boolean {
  let found = false;
  forEachTomlSyntaxLine(code, (line) => {
    if (found) return;
    const header = parseTomlHeader(line);
    found = header ? parseFirstDottedTomlKeyName(header.rawName) === name : false;
  });
  return found;
}

function findTomlSections(code: string, name: string, isArray: boolean): TomlSection[] {
  const sections: Array<TomlSection & { name: string; isArray: boolean }> = [];
  let current: (TomlSection & { name: string; isArray: boolean }) | undefined;
  forEachTomlSyntaxLine(code, (line, lineStart, lineEnd) => {
    const header = parseTomlHeader(line);
    if (!header) return;
    if (current) {
      current.bodyEnd = lineStart;
      sections.push(current);
    }
    current = {
      name: header.name,
      isArray: header.isArray,
      bodyStart: lineEnd,
      bodyEnd: code.length,
    };
  });
  if (current) sections.push(current);
  return sections.filter((section) => section.name === name && section.isArray === isArray);
}

function findTomlAssignmentInSection(
  code: string,
  section: TomlSection,
  name: string,
): TomlAssignment | undefined {
  let match: TomlAssignment | undefined;
  forEachTomlSyntaxLine(code.slice(section.bodyStart, section.bodyEnd), (line, lineStart) => {
    if (match) return;
    const uncommented = stripTomlLineComment(line);
    const assignment = findTomlAssignmentInLine(uncommented, name);
    if (!assignment) return;
    match = {
      valueStart: section.bodyStart + lineStart + assignment.valueStart,
      valueEnd: section.bodyStart + lineStart + assignment.valueEnd,
      value: assignment.value,
    };
  });
  return match;
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim();
  if (startsWithTomlMultilineString(trimmed)) return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return undefined;
}

function startsWithTomlMultilineString(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith(`"""`) || trimmed.startsWith("'''");
}

function assertSupportedOwnedTomlValue(value: { value: string }, description: string): void {
  if (startsWithTomlMultilineString(value.value)) {
    throw new Error(`Wrangler TOML uses unsupported multiline ${description}.`);
  }
}

function parseTomlBoolean(value: string): boolean | undefined {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return undefined;
}

// Finds `name = <value>` inside an inline TOML table (the substring between
// `{` and `}`) structurally, regardless of the value's TOML type. Depth
// tracking over `{`/`[` and quote tracking over strings means a comma or
// brace inside a nested value never gets mistaken for the entry boundary.
// Callers validate the returned value's shape themselves — this only finds
// the entry, so an owned key holding an unexpected type (e.g. a number or
// array) is found and can be replaced instead of silently duplicated.
function findInlineTomlProperty(
  value: string,
  name: string,
): { valueStart: number; valueEnd: number; value: string } | undefined {
  const open = value.indexOf("{");
  const close = value.lastIndexOf("}");
  if (open < 0 || close < open) return undefined;
  const inner = value.slice(open + 1, close);

  const checkEntry = (
    start: number,
    end: number,
  ): { valueStart: number; valueEnd: number; value: string } | undefined => {
    const entry = inner.slice(start, end);
    const assignment = findTomlAssignmentInLine(entry, name);
    if (!assignment) return undefined;
    const offset = open + 1 + start;
    return {
      valueStart: offset + assignment.valueStart,
      valueEnd: offset + assignment.valueEnd,
      value: assignment.value,
    };
  };

  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let entryStart = 0;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      const match = checkEntry(entryStart, index);
      if (match) return match;
      entryStart = index + 1;
    }
  }
  return checkEntry(entryStart, inner.length);
}

function isInlineTomlObject(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function replaceTomlAssignmentValue(
  code: string,
  assignment: TomlAssignment,
  value: string,
): string {
  return `${code.slice(0, assignment.valueStart)}${value}${code.slice(assignment.valueEnd)}`;
}

function setInlineTomlPropertyValue(
  code: string,
  assignment: TomlAssignment,
  name: string,
  value: string,
): string {
  const property = findInlineTomlProperty(assignment.value, name);
  if (property) {
    assertSupportedOwnedTomlValue(property, name);
    return `${code.slice(0, assignment.valueStart + property.valueStart)}${value}${code.slice(
      assignment.valueStart + property.valueEnd,
    )}`;
  }

  const close = assignment.value.lastIndexOf("}");
  if (close < 0) throw new Error("Expected an inline TOML object.");
  const beforeClose = assignment.value.slice(0, close);
  const separator = beforeClose.trim().endsWith("{") ? " " : ", ";
  return replaceTomlAssignmentValue(
    code,
    assignment,
    `${beforeClose}${separator}${name} = ${value} }`,
  );
}

function setTomlTableAssignmentValue(
  code: string,
  section: TomlSection,
  name: string,
  value: string,
): string {
  const assignment = findTomlAssignmentInSection(code, section, name);
  if (assignment) {
    assertSupportedOwnedTomlValue(assignment, name);
    return replaceTomlAssignmentValue(code, assignment, value);
  }

  const insertion = `${name} = ${value}\n`;
  return `${code.slice(0, section.bodyEnd)}${code[section.bodyEnd - 1] === "\n" ? "" : "\n"}${insertion}${code.slice(section.bodyEnd)}`;
}

function appendTomlTopLevelAssignment(code: string, assignment: string): string {
  const firstSectionStart = findFirstTomlSectionStart(code);
  if (firstSectionStart === undefined) {
    const separator = code.length === 0 || code.endsWith("\n") ? "" : "\n";
    return `${code}${separator}${assignment}\n`;
  }

  let before = code.slice(0, firstSectionStart);
  const after = code.slice(firstSectionStart);
  if (before.length > 0 && !before.endsWith("\n")) before += "\n";
  const separatorBefore = before.trim().length > 0 && !before.endsWith("\n\n") ? "\n" : "";
  const separatorAfter = after.length > 0 ? "\n" : "";
  return `${before}${separatorBefore}${assignment}\n${separatorAfter}${after}`;
}

function appendTomlArrayTable(code: string, table: string): string {
  const separator =
    code.length === 0 ? "" : code.endsWith("\n\n") ? "" : code.endsWith("\n") ? "\n" : "\n\n";
  return `${code}${separator}${table}\n`;
}

function singleTomlTable(code: string, name: string): TomlSection | undefined {
  const sections = findTomlSections(code, name, false);
  if (sections.length > 1) throw new Error(`Wrangler TOML defines ${name} twice.`);
  return sections[0];
}

function ensureTomlCacheEnabled(code: string): string {
  if (hasDottedTomlSectionHeader(code, "cache")) {
    throw new Error("Wrangler TOML uses unsupported dotted cache tables.");
  }
  if (hasTopLevelDottedKey(code, "cache")) {
    throw new Error("Wrangler TOML uses unsupported dotted cache keys.");
  }

  const inlineCache = findTopLevelTomlAssignment(code, "cache");
  const tableCache = singleTomlTable(code, "cache");
  if (inlineCache && tableCache) throw new Error("Wrangler TOML defines cache twice.");

  if (inlineCache) {
    if (!isInlineTomlObject(inlineCache.value)) {
      throw new Error("Expected top-level cache to be a TOML object.");
    }
    const enabled = findInlineTomlProperty(inlineCache.value, "enabled");
    if (enabled && parseTomlBoolean(enabled.value) === true) return code;
    return setInlineTomlPropertyValue(code, inlineCache, "enabled", "true");
  }

  if (tableCache) {
    const enabled = findTomlAssignmentInSection(code, tableCache, "enabled");
    if (enabled && parseTomlBoolean(enabled.value) === true) return code;
    return setTomlTableAssignmentValue(code, tableCache, "enabled", "true");
  }

  return appendTomlTopLevelAssignment(code, "cache = { enabled = true }");
}

function getWranglerTomlImagesBinding(code: string): string {
  const inlineImages = findTopLevelTomlAssignment(code, "images");
  if (inlineImages && isInlineTomlObject(inlineImages.value)) {
    const binding = findInlineTomlProperty(inlineImages.value, "binding");
    const value = binding ? parseTomlString(binding.value) : undefined;
    if (value) return value;
  }

  const tableImages = singleTomlTable(code, "images");
  if (tableImages) {
    const binding = findTomlAssignmentInSection(code, tableImages, "binding");
    const value = binding ? parseTomlString(binding.value) : undefined;
    if (value) return value;
  }

  return DEFAULT_IMAGES_BINDING;
}

function ensureTomlImagesBinding(code: string): string {
  if (hasDottedTomlSectionHeader(code, "images")) {
    throw new Error("Wrangler TOML uses unsupported dotted images tables.");
  }
  if (hasTopLevelDottedKey(code, "images")) {
    throw new Error("Wrangler TOML uses unsupported dotted images keys.");
  }

  const inlineImages = findTopLevelTomlAssignment(code, "images");
  const tableImages = singleTomlTable(code, "images");
  if (inlineImages && tableImages) throw new Error("Wrangler TOML defines images twice.");

  if (inlineImages) {
    if (!isInlineTomlObject(inlineImages.value)) {
      throw new Error("Expected top-level images to be a TOML object.");
    }
    const binding = findInlineTomlProperty(inlineImages.value, "binding");
    const value = binding ? parseTomlString(binding.value) : undefined;
    if (value) return code;
    return setInlineTomlPropertyValue(
      code,
      inlineImages,
      "binding",
      JSON.stringify(DEFAULT_IMAGES_BINDING),
    );
  }

  if (tableImages) {
    const binding = findTomlAssignmentInSection(code, tableImages, "binding");
    const value = binding ? parseTomlString(binding.value) : undefined;
    if (value) return code;
    return setTomlTableAssignmentValue(
      code,
      tableImages,
      "binding",
      JSON.stringify(DEFAULT_IMAGES_BINDING),
    );
  }

  return appendTomlTopLevelAssignment(
    code,
    `images = { binding = ${JSON.stringify(DEFAULT_IMAGES_BINDING)} }`,
  );
}

function findTomlKvNamespaceSection(code: string): TomlSection | undefined {
  return findTomlSections(code, "kv_namespaces", true).find((section) => {
    const binding = findTomlAssignmentInSection(code, section, "binding");
    if (binding) assertSupportedOwnedTomlValue(binding, "kv_namespaces values");
    return binding ? parseTomlString(binding.value) === VINEXT_KV_CACHE_BINDING : false;
  });
}

function ensureTomlKvNamespace(code: string): string {
  if (hasDottedTomlSectionHeader(code, "kv_namespaces")) {
    throw new Error("Wrangler TOML uses unsupported dotted kv_namespaces tables.");
  }
  if (findTopLevelTomlAssignment(code, "kv_namespaces")) {
    throw new Error("Wrangler TOML uses unsupported inline kv_namespaces.");
  }
  if (hasTopLevelDottedKey(code, "kv_namespaces")) {
    throw new Error("Wrangler TOML uses unsupported dotted kv_namespaces keys.");
  }
  if (findTomlKvNamespaceSection(code)) return code;
  return appendTomlArrayTable(
    code,
    `[[kv_namespaces]]\nbinding = ${JSON.stringify(VINEXT_KV_CACHE_BINDING)}\nid = ${JSON.stringify(KV_NAMESPACE_ID_PLACEHOLDER)}`,
  );
}

function tomlKvNamespaceNeedsId(code: string): boolean {
  const section = findTomlKvNamespaceSection(code);
  if (!section) return true;
  const id = findTomlAssignmentInSection(code, section, "id");
  if (id) assertSupportedOwnedTomlValue(id, "kv_namespaces values");
  const value = id ? parseTomlString(id.value) : undefined;
  return !value || value === KV_NAMESPACE_ID_PLACEHOLDER;
}

export function updateWranglerTomlConfigForCloudflare(
  code: string,
  options: CloudflareInitOptions,
): WranglerTomlConfigUpdate {
  let output = code;
  if (options.cdnCache === "workers-cache") {
    output = ensureTomlCacheEnabled(output);
  }
  if (options.imageOptimization === "cloudflare-images") {
    output = ensureTomlImagesBinding(output);
  }
  if (options.dataCache === "kv") {
    output = ensureTomlKvNamespace(output);
  }
  return {
    code: output,
    imagesBinding: getWranglerTomlImagesBinding(output),
    needsKvNamespaceId: options.dataCache === "kv" && tomlKvNamespaceNeedsId(output),
  };
}
