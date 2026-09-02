/** Encode and validate the lightweight AppElements slot identity wire shape. */
export function createAppElementsWireSlotId(slotName: string, treePath: string): string {
  return `slot:${slotName}:${treePath}`;
}

export function isAppElementsWireSlotId(key: string): boolean {
  if (!key.startsWith("slot:")) return false;
  const body = key.slice("slot:".length);
  const separatorIndex = body.indexOf(":");
  return separatorIndex > 0 && body.charCodeAt(separatorIndex + 1) === 0x2f;
}

export type AppElementsWireElementKey =
  | { kind: "layout"; treePath: string }
  | { interceptionContext: string | null; kind: "page"; path: string }
  | { interceptionContext: string | null; kind: "route"; path: string }
  | { kind: "slot"; name: string; treePath: string }
  | { kind: "template"; treePath: string };

function parsePathWithInterception(input: string): {
  interceptionContext: string | null;
  path: string;
} | null {
  const separatorIndex = input.indexOf("\0");
  const path = separatorIndex === -1 ? input : input.slice(0, separatorIndex);
  if (!path.startsWith("/")) return null;
  return {
    interceptionContext: separatorIndex === -1 ? null : input.slice(separatorIndex + 1),
    path,
  };
}

function parseTreePath(input: string): string | null {
  return input.startsWith("/") ? input : null;
}

export function parseAppElementsWireElementKey(key: string): AppElementsWireElementKey | null {
  if (key.startsWith("route:")) {
    const parsed = parsePathWithInterception(key.slice("route:".length));
    return parsed
      ? { interceptionContext: parsed.interceptionContext, kind: "route", path: parsed.path }
      : null;
  }
  if (key.startsWith("page:")) {
    const parsed = parsePathWithInterception(key.slice("page:".length));
    return parsed
      ? { interceptionContext: parsed.interceptionContext, kind: "page", path: parsed.path }
      : null;
  }
  if (key.startsWith("layout:")) {
    const treePath = parseTreePath(key.slice("layout:".length));
    return treePath ? { kind: "layout", treePath } : null;
  }
  if (key.startsWith("template:")) {
    const treePath = parseTreePath(key.slice("template:".length));
    return treePath ? { kind: "template", treePath } : null;
  }
  if (key.startsWith("slot:")) {
    const body = key.slice("slot:".length);
    const separatorIndex = body.indexOf(":");
    if (separatorIndex <= 0) return null;
    const treePath = parseTreePath(body.slice(separatorIndex + 1));
    return treePath ? { kind: "slot", name: body.slice(0, separatorIndex), treePath } : null;
  }
  return null;
}
