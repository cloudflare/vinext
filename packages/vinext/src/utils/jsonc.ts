/**
 * Strip `//` and block comments from JSONC and remove trailing commas so the
 * result parses with `JSON.parse`. String contents are preserved verbatim.
 *
 * Wrangler configs are the only callers; they never contain string values that
 * look like `,}` / `,]`, so the trailing-comma regex is safe here.
 */
export function stripJsonComments(code: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    const next = code[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < code.length && code[index] !== "\n") index++;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < code.length && !(code[index] === "*" && code[index + 1] === "/")) {
        output += code[index] === "\n" ? "\n" : " ";
        index++;
      }
      index++;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

/** Parse a JSONC (or plain JSON) document. Throws on malformed input. */
export function parseJsonc(code: string): unknown {
  return JSON.parse(stripJsonComments(code));
}
