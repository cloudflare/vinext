export function parseWorkersDevUrl(output: string): string | null {
  for (const rawToken of splitWhitespace(output)) {
    const candidate = trimUrlPunctuation(rawToken);
    if (!candidate.startsWith("https://")) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:") continue;
      if (url.hostname !== "workers.dev" && !url.hostname.endsWith(".workers.dev")) continue;
      if (url.pathname === "/" && url.search === "" && url.hash === "") {
        return url.origin;
      }
      return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

function splitWhitespace(value: string): string[] {
  const tokens: string[] = [];
  let tokenStart: number | null = null;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === undefined) continue;
    if (char.trim() === "") {
      if (tokenStart !== null) {
        tokens.push(value.slice(tokenStart, i));
        tokenStart = null;
      }
    } else if (tokenStart === null) {
      tokenStart = i;
    }
  }

  if (tokenStart !== null) {
    tokens.push(value.slice(tokenStart));
  }
  return tokens;
}

function trimUrlPunctuation(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && "\"'(<".includes(value[start]!)) start++;
  while (end > start && "\"')>.,;".includes(value[end - 1]!)) end--;
  return value.slice(start, end);
}
