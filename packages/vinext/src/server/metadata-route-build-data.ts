import { createHash } from "node:crypto";
import fs from "node:fs";
import { imageSize } from "image-size";
import {
  getMetadataRouteKind,
  type MetadataFileRoute,
  type MetadataRouteHeadData,
} from "./metadata-routes.js";

type ImageDimensions = {
  width?: number;
  height?: number;
};

type MetadataHeadDataInput = {
  route: MetadataFileRoute;
  contentHash: string;
  dimensions: ImageDimensions;
  altText?: string;
};

type MetadataRouteEntrySourceInput = {
  entryData: MetadataRouteEntryData;
  moduleName?: string;
  patternParts?: readonly string[] | null;
};

type MetadataRouteEntryData = {
  type: MetadataFileRoute["type"];
  isDynamic: boolean;
  routePrefix: string;
  routeSegments: readonly string[];
  servedUrl: string;
  contentType: string;
  contentHash: string;
  headData?: MetadataRouteHeadData | null;
  fileDataBase64?: string;
};

function createMetadataContentHash(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex").slice(0, 16);
}

function readMetadataRouteFile(route: MetadataFileRoute): Buffer {
  try {
    return fs.readFileSync(route.filePath);
  } catch (error) {
    const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new Error(
      `[vinext] Failed to read metadata route file ${route.filePath} for ${route.servedUrl}${reason}`,
      { cause: error },
    );
  }
}

function readMetadataRouteTextFile(filePath: string, route: MetadataFileRoute): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new Error(
      `[vinext] Failed to read metadata route file ${filePath} for ${route.servedUrl}${reason}`,
      { cause: error },
    );
  }
}

function readMetadataRouteAltText(route: MetadataFileRoute): string | undefined {
  return route.altFilePath ? readMetadataRouteTextFile(route.altFilePath, route) : undefined;
}

function readMetadataImageDimensions(buffer: Buffer, route: MetadataFileRoute): ImageDimensions {
  try {
    const dimensions = imageSize(buffer);
    return {
      width: dimensions.width,
      height: dimensions.height,
    };
  } catch (error) {
    const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new Error(
      `[vinext] Failed to read metadata image dimensions for ${route.filePath} (${route.servedUrl})${reason}`,
      { cause: error },
    );
  }
}

function resolveIconSizes(
  routeKind: MetadataRouteHeadData["kind"],
  isSvgRoute: boolean,
  dimensions: ImageDimensions,
): string | undefined {
  if (routeKind !== "favicon" && routeKind !== "icon" && routeKind !== "apple") {
    return undefined;
  }
  if (isSvgRoute) {
    return "any";
  }
  if (dimensions.width && dimensions.height) {
    return `${dimensions.width}x${dimensions.height}`;
  }
  return "any";
}

function createMetadataHeadData(input: MetadataHeadDataInput): MetadataRouteHeadData | null {
  const { route, contentHash, dimensions, altText } = input;
  const routeKind = getMetadataRouteKind(route);
  if (!routeKind) {
    return null;
  }
  if (routeKind === "manifest") {
    return { kind: "manifest", href: route.servedUrl };
  }

  const href = `${route.servedUrl}?${contentHash}`;
  const isSvgRoute =
    route.contentType === "image/svg+xml" || route.servedUrl.toLowerCase().endsWith(".svg");

  if (routeKind === "favicon" || routeKind === "icon" || routeKind === "apple") {
    return {
      kind: routeKind,
      href,
      type: route.contentType,
      sizes: resolveIconSizes(routeKind, isSvgRoute, dimensions),
    };
  }

  return {
    kind: routeKind,
    href,
    type: route.contentType,
    width: dimensions.width,
    height: dimensions.height,
    alt: altText,
  };
}

function createBaseEntryData(
  route: MetadataFileRoute,
  contentHash: string,
): MetadataRouteEntryData {
  return {
    type: route.type,
    isDynamic: route.isDynamic,
    routePrefix: route.routePrefix,
    routeSegments: route.routeSegments ?? [],
    servedUrl: route.servedUrl,
    contentType: route.contentType,
    contentHash,
  };
}

function readStaticMetadataImageDimensions(
  route: MetadataFileRoute,
  buffer: Buffer,
): ImageDimensions {
  return route.contentType.startsWith("image/") ? readMetadataImageDimensions(buffer, route) : {};
}

export function createMetadataRouteEntryData(route: MetadataFileRoute): MetadataRouteEntryData {
  const buffer = readMetadataRouteFile(route);
  const contentHash = createMetadataContentHash(buffer);
  const entryData = createBaseEntryData(route, contentHash);

  if (route.isDynamic) {
    if (route.type === "manifest") {
      return {
        ...entryData,
        headData: { kind: "manifest", href: route.servedUrl },
      };
    }
    return entryData;
  }

  return {
    ...entryData,
    headData: createMetadataHeadData({
      route,
      contentHash,
      dimensions: readStaticMetadataImageDimensions(route, buffer),
      altText: readMetadataRouteAltText(route),
    }),
    fileDataBase64: buffer.toString("base64"),
  };
}

function pushEntryProperty(lines: string[], key: string, value: unknown): void {
  if (value !== undefined) {
    lines.push(`${key}: ${JSON.stringify(value)},`);
  }
}

function metadataRoutePatternPart(segment: string): string {
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

function createMetadataRoutePatternParts(route: MetadataFileRoute): readonly string[] | null {
  if (!route.isDynamic || !route.servedUrl.includes("[")) {
    return null;
  }
  return route.servedUrl.split("/").filter(Boolean).map(metadataRoutePatternPart);
}

function getDynamicMetadataRouteModuleName(
  route: MetadataFileRoute,
  moduleNames: ReadonlyMap<string, string>,
): string | undefined {
  if (!route.isDynamic) {
    return undefined;
  }
  const moduleName = moduleNames.get(route.filePath);
  if (!moduleName) {
    throw new Error(
      `[vinext] Missing generated module import for dynamic metadata route ${route.filePath}`,
    );
  }
  return moduleName;
}

export function createMetadataRouteEntrySource(input: MetadataRouteEntrySourceInput): string {
  const { entryData, moduleName, patternParts } = input;
  const lines: string[] = [];

  pushEntryProperty(lines, "type", entryData.type);
  pushEntryProperty(lines, "isDynamic", entryData.isDynamic);
  pushEntryProperty(lines, "routePrefix", entryData.routePrefix);
  pushEntryProperty(lines, "routeSegments", entryData.routeSegments);
  pushEntryProperty(lines, "servedUrl", entryData.servedUrl);
  pushEntryProperty(lines, "contentType", entryData.contentType);
  pushEntryProperty(lines, "contentHash", entryData.contentHash);
  pushEntryProperty(lines, "headData", entryData.headData);
  pushEntryProperty(lines, "fileDataBase64", entryData.fileDataBase64);

  if (moduleName) {
    lines.push(`module: ${moduleName},`);
  }
  if (patternParts) {
    lines.push(`patternParts: ${JSON.stringify(patternParts)},`);
  }

  return `  {\n    ${lines.join("\n    ")}\n  }`;
}

export function createMetadataRouteEntriesSource(
  routes: readonly MetadataFileRoute[],
  moduleNames: ReadonlyMap<string, string>,
): string[] {
  return routes.map((route) =>
    createMetadataRouteEntrySource({
      entryData: createMetadataRouteEntryData(route),
      moduleName: getDynamicMetadataRouteModuleName(route, moduleNames),
      patternParts: createMetadataRoutePatternParts(route),
    }),
  );
}
