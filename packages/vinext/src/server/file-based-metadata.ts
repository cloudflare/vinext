import type { Metadata } from "../shims/metadata.js";
import { makeThenableParams } from "../shims/thenable-params.js";
import {
  getMetadataImageRouteKind,
  getMetadataRouteKind,
  isValidMetadataImageId,
  type MetadataFileRoute,
  type MetadataRouteHeadData,
} from "./metadata-routes.js";

type AppPageParams = Record<string, string | string[]>;

type IconEntry = {
  url: string | URL;
  sizes?: string;
  type?: string;
  media?: string;
};

type AppleIconEntry = {
  url: string | URL;
  sizes?: string;
  type?: string;
};

type SocialImageEntry = {
  url: string | URL;
  width?: number;
  height?: number;
  alt?: string;
  type?: string;
};

type DynamicImageSize = {
  width?: number;
  height?: number;
};

type DynamicImageMetadataSource = {
  id?: string | number;
  alt?: string;
  contentType?: string;
  size?: DynamicImageSize;
};

type FileBasedMetadataSource = {
  routeSegments: readonly string[];
  metadata: Metadata | null;
};

type FileBasedMetadataOptions = {
  routeSegments?: readonly string[] | null;
  metadataSources?: readonly FileBasedMetadataSource[] | null;
};

type IconMap = {
  icon?: string | URL | IconEntry | IconEntry[];
  shortcut?: string | URL | Array<string | URL>;
  apple?: string | URL | AppleIconEntry | AppleIconEntry[];
  other?: Array<{ rel: string; url: string | URL; sizes?: string; type?: string }>;
};

function routeApplies(routePath: string, routePrefix: string): boolean {
  if (!routePrefix) {
    return true;
  }
  return routePath === routePrefix || routePath.startsWith(`${routePrefix}/`);
}

function routeScore(routePrefix: string): number {
  return routePrefix.split("/").filter(Boolean).length;
}

function routeSegmentsApply(
  routeSegments: readonly string[],
  routePrefixSegments: readonly string[],
): boolean {
  if (routePrefixSegments.length > routeSegments.length) {
    return false;
  }

  for (let index = 0; index < routePrefixSegments.length; index++) {
    if (routeSegments[index] !== routePrefixSegments[index]) {
      return false;
    }
  }

  return true;
}

function removeParallelRouteSegments(routeSegments: readonly string[]): string[] {
  return routeSegments.filter((segment) => !segment.startsWith("@"));
}

function routeSegmentsApplyWithParallelSlots(
  routeSegments: readonly string[],
  routePrefixSegments: readonly string[],
): boolean {
  if (routeSegmentsApply(routeSegments, routePrefixSegments)) {
    return true;
  }

  const visiblePrefixSegments = removeParallelRouteSegments(routePrefixSegments);
  return (
    visiblePrefixSegments.length !== routePrefixSegments.length &&
    routeSegmentsApply(routeSegments, visiblePrefixSegments)
  );
}

function routeSpecificity(route: MetadataFileRoute): number {
  return route.routeSegments?.length ?? routeScore(route.routePrefix);
}

function normalizeRoutePrefixPattern(routePrefix: string): string {
  const segments = routePrefix
    .split("/")
    .filter(Boolean)
    .map((segment) => {
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
    });

  return segments.length > 0 ? `/${segments.join("/")}` : "";
}

function selectDeepestRoutes(
  metadataRoutes: readonly MetadataFileRoute[] | null | undefined,
  kind: MetadataRouteHeadData["kind"],
  routePath: string,
  params: AppPageParams,
  routeSegments: readonly string[] | null | undefined,
): MetadataFileRoute[] {
  if (!metadataRoutes || metadataRoutes.length === 0) {
    return [];
  }

  let selectedScore = -1;
  const selectedRoutes: MetadataFileRoute[] = [];

  for (const route of metadataRoutes) {
    const routeKind = route.headData?.kind ?? getMetadataRouteKind(route);

    if (routeKind !== kind) {
      continue;
    }

    if (routeSegments && route.routeSegments) {
      // Raw app-tree segments are authoritative when present. Falling back to
      // visible URL prefixes here would reintroduce route-group collisions.
      if (!routeSegmentsApplyWithParallelSlots(routeSegments, route.routeSegments)) {
        continue;
      }
      const currentScore = routeSpecificity(route);
      if (currentScore > selectedScore) {
        selectedScore = currentScore;
        selectedRoutes.length = 0;
        selectedRoutes.push(route);
        continue;
      }

      if (currentScore === selectedScore) {
        selectedRoutes.push(route);
      }
      continue;
    }

    const routePrefix = route.routePrefix;
    const resolvedRoutePrefix = fillMetadataRouteSegments(routePrefix, params);
    const normalizedRoutePrefix = normalizeRoutePrefixPattern(routePrefix);
    if (
      !routeApplies(routePath, routePrefix) &&
      !routeApplies(routePath, normalizedRoutePrefix) &&
      (!resolvedRoutePrefix || !routeApplies(routePath, resolvedRoutePrefix))
    ) {
      continue;
    }

    const currentScore = routeSpecificity(route);
    if (currentScore > selectedScore) {
      selectedScore = currentScore;
      selectedRoutes.length = 0;
      selectedRoutes.push(route);
      continue;
    }

    if (currentScore === selectedScore) {
      selectedRoutes.push(route);
    }
  }

  return selectedRoutes;
}

function isStringOrUrl(value: unknown): value is string | URL {
  return typeof value === "string" || (typeof value === "object" && value instanceof URL);
}

function normalizeIconDescriptor(value: unknown): IconEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const urlValue = Reflect.get(value, "url");
  if (!isStringOrUrl(urlValue)) {
    return null;
  }

  const entry: IconEntry = { url: urlValue };

  const sizesValue = Reflect.get(value, "sizes");
  if (typeof sizesValue === "string") {
    entry.sizes = sizesValue;
  }

  const typeValue = Reflect.get(value, "type");
  if (typeof typeValue === "string") {
    entry.type = typeValue;
  }

  const mediaValue = Reflect.get(value, "media");
  if (typeof mediaValue === "string") {
    entry.media = mediaValue;
  }

  return entry;
}

function normalizeIconValue(value: unknown): IconEntry | null {
  if (isStringOrUrl(value)) {
    return { url: value };
  }

  return normalizeIconDescriptor(value);
}

function normalizeIconEntries(icon: NonNullable<Metadata["icons"]>): IconEntry[] {
  if (isStringOrUrl(icon)) {
    return [{ url: icon }];
  }

  if (Array.isArray(icon)) {
    const normalizedEntries: IconEntry[] = [];
    for (const value of icon) {
      const normalizedValue = normalizeIconValue(value);
      if (normalizedValue) {
        normalizedEntries.push(normalizedValue);
      }
    }
    return normalizedEntries;
  }

  const normalizedTopLevelValue = normalizeIconDescriptor(icon);
  if (normalizedTopLevelValue) {
    return [normalizedTopLevelValue];
  }

  if (!isIconMap(icon)) {
    return [];
  }

  const iconValue = icon.icon;
  if (!iconValue) {
    return [];
  }

  if (Array.isArray(iconValue)) {
    const normalizedEntries: IconEntry[] = [];
    for (const value of iconValue) {
      const normalizedValue = normalizeIconValue(value);
      if (normalizedValue) {
        normalizedEntries.push(normalizedValue);
      }
    }
    return normalizedEntries;
  }

  const normalizedValue = normalizeIconValue(iconValue);
  return normalizedValue ? [normalizedValue] : [];
}

function isIconMap(value: Metadata["icons"]): value is IconMap {
  if (!value || typeof value !== "object" || value instanceof URL || Array.isArray(value)) {
    return false;
  }
  return normalizeIconDescriptor(value) === null;
}

function cloneIconMap(value: Metadata["icons"]): IconMap {
  if (!value) {
    return {};
  }

  if (isIconMap(value)) {
    return { ...value };
  }

  const iconEntries = normalizeIconEntries(value);
  return iconEntries.length > 0 ? { icon: iconEntries } : {};
}

function buildIconEntry(headData: MetadataRouteHeadData): IconEntry | null {
  if (headData.kind !== "favicon" && headData.kind !== "icon") {
    return null;
  }

  const iconEntry: IconEntry = {
    url: headData.href,
  };
  if (headData.sizes) {
    iconEntry.sizes = headData.sizes;
  }
  if (headData.type) {
    iconEntry.type = headData.type;
  }
  return iconEntry;
}

function buildAppleEntry(headData: MetadataRouteHeadData): AppleIconEntry | null {
  if (headData.kind !== "apple") {
    return null;
  }

  const appleEntry: AppleIconEntry = {
    url: headData.href,
  };
  if (headData.sizes) {
    appleEntry.sizes = headData.sizes;
  }
  if (headData.type) {
    appleEntry.type = headData.type;
  }
  return appleEntry;
}

function normalizeAppleEntry(value: string | URL | AppleIconEntry): AppleIconEntry {
  if (isStringOrUrl(value)) {
    return { url: value };
  }
  return { ...value };
}

function buildSocialEntry(headData: MetadataRouteHeadData): SocialImageEntry | null {
  if (headData.kind !== "openGraph" && headData.kind !== "twitter") {
    return null;
  }

  const socialEntry: SocialImageEntry = {
    url: headData.href,
  };
  if (headData.width !== undefined) {
    socialEntry.width = headData.width;
  }
  if (headData.height !== undefined) {
    socialEntry.height = headData.height;
  }
  if (headData.alt) {
    socialEntry.alt = headData.alt;
  }
  if (headData.type) {
    socialEntry.type = headData.type;
  }
  return socialEntry;
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

function fillMetadataRouteSegments(servedUrl: string, params: AppPageParams): string | null {
  const segments = servedUrl.split("/").filter(Boolean);
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

function normalizeMetadataImageId(route: MetadataFileRoute, id: string | number): string | null {
  const normalizedId = String(id);
  if (!isValidMetadataImageId(normalizedId)) {
    console.warn(
      `[vinext] Skipping metadata route ${route.servedUrl} image id "${normalizedId}" because metadata image ids must match /^[a-zA-Z0-9-_.]+$/.`,
    );
    return null;
  }
  return normalizedId;
}

function withContentHash(href: string, contentHash?: string): string {
  if (!contentHash) {
    return href;
  }
  return `${href}?${contentHash}`;
}

function hasOwnProperty(source: object | null | undefined, key: string): boolean {
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
}

function hasOpenGraphImages(metadata: Metadata | null | undefined): boolean {
  return hasOwnProperty(metadata?.openGraph, "images");
}

function hasTwitterImages(metadata: Metadata | null | undefined): boolean {
  return hasOwnProperty(metadata?.twitter, "images");
}

function hasIcons(metadata: Metadata | null | undefined): boolean {
  return Boolean(metadata?.icons);
}

function getMetadataSourceForRoute(
  route: MetadataFileRoute,
  options: FileBasedMetadataOptions | undefined,
  fallbackMetadata: Metadata | null,
): Metadata | null {
  if (!options?.metadataSources) {
    return fallbackMetadata;
  }

  if (!route.routeSegments) {
    return null;
  }

  for (let index = options.metadataSources.length - 1; index >= 0; index--) {
    const source = options.metadataSources[index];
    if (routeSegmentsApplyWithParallelSlots(source.routeSegments, route.routeSegments)) {
      return source.metadata;
    }
  }

  return null;
}

function socialRouteHasExplicitImagesAtSource(
  route: MetadataFileRoute,
  kind: "openGraph" | "twitter",
  options: FileBasedMetadataOptions | undefined,
  fallbackMetadata: Metadata | null,
): boolean {
  const sourceMetadata = getMetadataSourceForRoute(route, options, fallbackMetadata);
  return kind === "openGraph"
    ? hasOpenGraphImages(sourceMetadata)
    : hasTwitterImages(sourceMetadata);
}

function iconRouteHasExplicitIconsAtSource(
  route: MetadataFileRoute,
  options: FileBasedMetadataOptions | undefined,
  fallbackMetadata: Metadata | null,
): boolean {
  // Next suppresses file icon routes when any resolved icons metadata exists.
  // Social image routes stay segment-scoped instead of using this merged fallback.
  return hasIcons(fallbackMetadata) || hasIcons(getMetadataSourceForRoute(route, options, null));
}

function readStringProperty(source: object, key: string): string | undefined {
  const value = Reflect.get(source, key);
  return typeof value === "string" ? value : undefined;
}

function readNumberProperty(source: object, key: string): number | undefined {
  const value = Reflect.get(source, key);
  return typeof value === "number" ? value : undefined;
}

function readStringOrNumberProperty(source: object, key: string): string | number | undefined {
  const value = Reflect.get(source, key);
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return undefined;
}

function readSizeProperty(source: object): DynamicImageSize | undefined {
  const sizeValue = Reflect.get(source, "size");
  if (typeof sizeValue !== "object" || sizeValue === null) {
    return undefined;
  }

  const width = readNumberProperty(sizeValue, "width");
  const height = readNumberProperty(sizeValue, "height");
  if (width === undefined && height === undefined) {
    return undefined;
  }

  return { width, height };
}

function readDynamicImageMetadataSource(source: object): DynamicImageMetadataSource {
  return {
    id: readStringOrNumberProperty(source, "id"),
    alt: readStringProperty(source, "alt"),
    contentType: readStringProperty(source, "contentType"),
    size: readSizeProperty(source),
  };
}

async function resolveDynamicImageMetadataSources(
  route: MetadataFileRoute,
  params: AppPageParams,
): Promise<DynamicImageMetadataSource[]> {
  if (!route.module || typeof route.module !== "object") {
    return [];
  }

  const generateImageMetadata = Reflect.get(route.module, "generateImageMetadata");
  if (typeof generateImageMetadata !== "function") {
    return [readDynamicImageMetadataSource(route.module)];
  }

  const result = await generateImageMetadata({ params: makeThenableParams(params) });
  if (!Array.isArray(result)) {
    return [];
  }

  const sources: DynamicImageMetadataSource[] = [];
  for (const entry of result) {
    if (typeof entry === "object" && entry !== null) {
      const source = readDynamicImageMetadataSource(entry);
      if (source.id === undefined) {
        console.warn(
          `[vinext] Skipping metadata route ${route.servedUrl} image metadata entry because generateImageMetadata entries must include an id.`,
        );
        continue;
      }
      sources.push(source);
    }
  }
  return sources;
}

async function resolveRouteHeadData(
  route: MetadataFileRoute,
  params: AppPageParams,
): Promise<MetadataRouteHeadData[]> {
  if (!route.isDynamic || !route.module || typeof route.module !== "object") {
    return route.headData ? [route.headData] : [];
  }

  const routeKind = getMetadataImageRouteKind(route);
  if (!routeKind) {
    return route.headData ? [route.headData] : [];
  }

  // servedUrl must stay query-free here; content hashes are appended after dynamic segment filling.
  const resolvedUrl = fillMetadataRouteSegments(route.servedUrl, params);
  if (!resolvedUrl) {
    console.warn(
      `[vinext] Skipping metadata route ${route.servedUrl} because params did not fill all dynamic segments.`,
    );
    return [];
  }
  const metadataSources = await resolveDynamicImageMetadataSources(route, params);
  const resolvedHeadData: MetadataRouteHeadData[] = [];

  for (const metadataSource of metadataSources) {
    let hrefBase = resolvedUrl;
    if (metadataSource.id !== undefined) {
      const normalizedId = normalizeMetadataImageId(route, metadataSource.id);
      if (!normalizedId) {
        continue;
      }
      hrefBase = `${resolvedUrl}/${normalizedId}`;
    }
    const href = withContentHash(hrefBase, route.contentHash);
    const contentType = metadataSource.contentType ?? route.contentType;
    const size = metadataSource.size;

    if (routeKind === "icon" || routeKind === "apple") {
      let sizes: string | undefined;
      if (size?.width !== undefined && size.height !== undefined) {
        sizes = `${size.width}x${size.height}`;
      }

      resolvedHeadData.push({
        kind: routeKind,
        href,
        sizes,
        type: contentType,
      });
      continue;
    }

    resolvedHeadData.push({
      kind: routeKind,
      href,
      alt: metadataSource.alt,
      height: size?.height,
      type: contentType,
      width: size?.width,
    });
  }

  return resolvedHeadData;
}

async function resolveHeadDataList(
  routes: MetadataFileRoute[],
  params: AppPageParams,
): Promise<MetadataRouteHeadData[]> {
  const headDataList = await Promise.all(
    routes.map((route) => resolveRouteHeadData(route, params)),
  );
  return headDataList.flat();
}

export async function applyFileBasedMetadata(
  metadata: Metadata | null,
  routePath: string,
  params: AppPageParams,
  metadataRoutes: readonly MetadataFileRoute[] | null | undefined,
  options?: FileBasedMetadataOptions,
): Promise<Metadata | null> {
  if (!metadataRoutes || metadataRoutes.length === 0) {
    return metadata;
  }

  const routeSegments = options?.routeSegments ?? null;
  const faviconRoutes = selectDeepestRoutes(
    metadataRoutes,
    "favicon",
    routePath,
    params,
    routeSegments,
  );
  const iconRoutes = selectDeepestRoutes(
    metadataRoutes,
    "icon",
    routePath,
    params,
    routeSegments,
  ).filter((route) => !iconRouteHasExplicitIconsAtSource(route, options, metadata));
  const appleRoutes = selectDeepestRoutes(
    metadataRoutes,
    "apple",
    routePath,
    params,
    routeSegments,
  ).filter((route) => !iconRouteHasExplicitIconsAtSource(route, options, metadata));
  const openGraphRoutes = selectDeepestRoutes(
    metadataRoutes,
    "openGraph",
    routePath,
    params,
    routeSegments,
  ).filter((route) => !socialRouteHasExplicitImagesAtSource(route, "openGraph", options, metadata));
  const twitterRoutes = selectDeepestRoutes(
    metadataRoutes,
    "twitter",
    routePath,
    params,
    routeSegments,
  ).filter((route) => !socialRouteHasExplicitImagesAtSource(route, "twitter", options, metadata));
  const manifestRoutes = selectDeepestRoutes(
    metadataRoutes,
    "manifest",
    routePath,
    params,
    routeSegments,
  );

  const [
    faviconHeadData,
    iconHeadData,
    appleHeadData,
    openGraphHeadData,
    twitterHeadData,
    manifestHeadData,
  ] = await Promise.all([
    resolveHeadDataList(faviconRoutes, params),
    resolveHeadDataList(iconRoutes, params),
    resolveHeadDataList(appleRoutes, params),
    resolveHeadDataList(openGraphRoutes, params),
    resolveHeadDataList(twitterRoutes, params),
    resolveHeadDataList(manifestRoutes, params),
  ]);

  if (
    !metadata &&
    faviconHeadData.length === 0 &&
    iconHeadData.length === 0 &&
    appleHeadData.length === 0 &&
    openGraphHeadData.length === 0 &&
    twitterHeadData.length === 0 &&
    manifestHeadData.length === 0
  ) {
    return null;
  }

  const nextMetadata: Metadata = metadata ? { ...metadata } : {};

  const faviconEntries: IconEntry[] = [];
  for (const headData of faviconHeadData) {
    const iconEntry = buildIconEntry(headData);
    if (iconEntry) {
      faviconEntries.push(iconEntry);
    }
  }
  if (faviconEntries.length > 0) {
    const nextIcons = cloneIconMap(nextMetadata.icons);
    const normalizedIcons = normalizeIconEntries(nextIcons);
    nextIcons.icon = [...faviconEntries, ...normalizedIcons];
    nextMetadata.icons = nextIcons;
  }

  {
    const nextIcons = cloneIconMap(nextMetadata.icons);

    const iconEntries: IconEntry[] = [];
    for (const headData of iconHeadData) {
      const iconEntry = buildIconEntry(headData);
      if (iconEntry) {
        iconEntries.push(iconEntry);
      }
    }
    if (iconEntries.length > 0) {
      const normalizedIcons = normalizeIconEntries(nextIcons);
      nextIcons.icon = [...iconEntries, ...normalizedIcons];
    }

    const appleEntries: AppleIconEntry[] = [];
    for (const headData of appleHeadData) {
      const appleEntry = buildAppleEntry(headData);
      if (appleEntry) {
        appleEntries.push(appleEntry);
      }
    }
    if (appleEntries.length > 0) {
      const existingApple = nextIcons.apple;
      const normalizedAppleEntries: AppleIconEntry[] = [];
      if (Array.isArray(existingApple)) {
        for (const entry of existingApple) {
          normalizedAppleEntries.push(normalizeAppleEntry(entry));
        }
      } else if (existingApple) {
        normalizedAppleEntries.push(normalizeAppleEntry(existingApple));
      }
      nextIcons.apple = [...appleEntries, ...normalizedAppleEntries];
    }

    if (iconEntries.length > 0 || appleEntries.length > 0) {
      nextMetadata.icons = nextIcons;
    }
  }

  if (openGraphHeadData.length > 0) {
    const socialEntries: SocialImageEntry[] = [];
    for (const headData of openGraphHeadData) {
      const socialEntry = buildSocialEntry(headData);
      if (socialEntry) {
        socialEntries.push(socialEntry);
      }
    }
    if (socialEntries.length > 0) {
      const nextOpenGraph: NonNullable<Metadata["openGraph"]> = nextMetadata.openGraph
        ? { ...nextMetadata.openGraph }
        : {};
      nextOpenGraph.images = socialEntries;
      nextMetadata.openGraph = nextOpenGraph;
    }
  }

  if (twitterHeadData.length > 0) {
    const socialEntries: SocialImageEntry[] = [];
    for (const headData of twitterHeadData) {
      const socialEntry = buildSocialEntry(headData);
      if (socialEntry) {
        socialEntries.push(socialEntry);
      }
    }
    if (socialEntries.length > 0) {
      const nextTwitter: NonNullable<Metadata["twitter"]> = nextMetadata.twitter
        ? { ...nextMetadata.twitter }
        : {};
      nextTwitter.images = socialEntries;
      nextMetadata.twitter = nextTwitter;
    }
  }

  if (manifestHeadData.length > 0 && manifestHeadData[0].kind === "manifest") {
    nextMetadata.manifest = manifestHeadData[0].href;
  }

  return nextMetadata;
}
