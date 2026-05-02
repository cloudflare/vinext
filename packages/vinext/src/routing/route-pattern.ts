export type RoutePatternParams = Record<string, string | string[]>;

function routePatternPart(segment: string): string {
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    return `:${segment.slice(5, -2)}*`;
  }
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return `:${segment.slice(4, -1)}+`;
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return `:${segment.slice(1, -1)}`;
  }
  return segment;
}

export function routePatternParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(routePatternPart);
}

export function routePattern(pathname: string): string {
  const parts = routePatternParts(pathname);
  return parts.length > 0 ? `/${parts.join("/")}` : "";
}

function appendParamValue(target: string[], value: string | string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      target.push(entry);
    }
    return;
  }

  target.push(value);
}

export function fillRoutePatternSegments(
  pathname: string,
  params: RoutePatternParams,
): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const resolvedSegments: string[] = [];

  for (const segment of segments) {
    if (segment.startsWith("[[...") && segment.endsWith("]]")) {
      const paramName = segment.slice(5, -2);
      const value = params[paramName];
      if (value !== undefined && value !== "") {
        if (Array.isArray(value) && value.length === 0) {
          continue;
        }
        appendParamValue(resolvedSegments, value);
      }
      continue;
    }

    if (segment.startsWith("[...") && segment.endsWith("]")) {
      const paramName = segment.slice(4, -1);
      const value = params[paramName];
      if (value === undefined || (Array.isArray(value) ? value.length === 0 : value === "")) {
        return null;
      }
      appendParamValue(resolvedSegments, value);
      continue;
    }

    if (segment.startsWith("[") && segment.endsWith("]")) {
      const paramName = segment.slice(1, -1);
      const value = params[paramName];
      if (typeof value === "string") {
        resolvedSegments.push(value);
        continue;
      }
      if (Array.isArray(value) && value.length > 0) {
        if (value.length > 1) {
          return null;
        }
        resolvedSegments.push(value[0]);
        continue;
      }
      return null;
    }

    resolvedSegments.push(segment);
  }

  return resolvedSegments.length > 0 ? `/${resolvedSegments.join("/")}` : "/";
}

export function matchRoutePattern(
  urlParts: readonly string[],
  patternParts: readonly string[],
): RoutePatternParams | null {
  const params: RoutePatternParams = Object.create(null);

  function matchFrom(urlIndex: number, patternIndex: number): boolean {
    if (patternIndex === patternParts.length) {
      return urlIndex === urlParts.length;
    }

    const patternPart = patternParts[patternIndex];
    if (patternPart.startsWith(":") && (patternPart.endsWith("+") || patternPart.endsWith("*"))) {
      const paramName = patternPart.slice(1, -1);
      const minLength = patternPart.endsWith("+") ? 1 : 0;
      for (let endIndex = urlIndex + minLength; endIndex <= urlParts.length; endIndex++) {
        const value = urlParts.slice(urlIndex, endIndex);
        if (value.length > 0) {
          params[paramName] = value;
        } else {
          delete params[paramName];
        }
        if (matchFrom(endIndex, patternIndex + 1)) {
          return true;
        }
      }
      delete params[paramName];
      return false;
    }

    if (patternPart.startsWith(":")) {
      if (urlIndex >= urlParts.length) {
        return false;
      }
      const paramName = patternPart.slice(1);
      params[paramName] = urlParts[urlIndex];
      if (matchFrom(urlIndex + 1, patternIndex + 1)) {
        return true;
      }
      delete params[paramName];
      return false;
    }

    if (urlIndex >= urlParts.length || urlParts[urlIndex] !== patternPart) {
      return false;
    }
    return matchFrom(urlIndex + 1, patternIndex + 1);
  }

  return matchFrom(0, 0) ? params : null;
}
