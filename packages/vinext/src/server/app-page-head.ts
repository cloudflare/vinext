import {
  mergeMetadata,
  mergeViewport,
  resolveModuleMetadata,
  resolveModuleViewport,
  type Metadata,
  type Viewport,
} from "../shims/metadata.js";
import type { AppPageParams } from "./app-page-boundary.js";
import { resolveAppPageSegmentParams } from "./app-page-params.js";

type AppPageHeadModule = Record<string, unknown>;
type AppPageSearchParamsObject = Record<string, string | string[]>;

type ResolveAppPageHeadOptions<TModule extends AppPageHeadModule> = {
  layoutModules: readonly (TModule | null | undefined)[];
  layoutTreePositions?: readonly number[] | null;
  pageModule?: TModule | null;
  params: AppPageParams;
  routeSegments?: readonly string[] | null;
  searchParams?: URLSearchParams | null;
};

type ResolveAppPageHeadResult = {
  hasSearchParams: boolean;
  metadata: Metadata | null;
  searchParamsObject: AppPageSearchParamsObject;
  viewport: Viewport;
};

type AppPageSearchParamsCollection = {
  hasSearchParams: boolean;
  searchParamsObject: AppPageSearchParamsObject;
};

function isMetadata(value: Metadata | null): value is Metadata {
  return value !== null;
}

function isViewport(value: Viewport | null): value is Viewport {
  return value !== null;
}

export function collectAppPageSearchParams(
  searchParams: URLSearchParams | null | undefined,
): AppPageSearchParamsCollection {
  const searchParamsObject: AppPageSearchParamsObject = Object.create(null);
  let hasSearchParams = false;

  if (!searchParams) {
    return { hasSearchParams, searchParamsObject };
  }

  searchParams.forEach((value, key) => {
    hasSearchParams = true;
    const current = searchParamsObject[key];
    if (Array.isArray(current)) {
      searchParamsObject[key] = [...current, value];
      return;
    }
    if (current !== undefined) {
      searchParamsObject[key] = [current, value];
      return;
    }
    searchParamsObject[key] = value;
  });

  return { hasSearchParams, searchParamsObject };
}

export async function resolveAppPageHead<TModule extends AppPageHeadModule>(
  options: ResolveAppPageHeadOptions<TModule>,
): Promise<ResolveAppPageHeadResult> {
  const { hasSearchParams, searchParamsObject } = collectAppPageSearchParams(options.searchParams);
  const layoutMetadataPromises: Promise<Metadata | null>[] = [];
  const layoutViewportPromises: Promise<Viewport | null>[] = [];
  let accumulatedMetadata = Promise.resolve<Metadata>({});

  for (let index = 0; index < options.layoutModules.length; index++) {
    const layoutModule = options.layoutModules[index];
    if (!layoutModule) {
      continue;
    }

    const parentForLayout = accumulatedMetadata;
    const layoutParams = resolveAppPageSegmentParams(
      options.routeSegments,
      options.layoutTreePositions?.[index] ?? 0,
      options.params,
    );
    const metadataPromise = resolveModuleMetadata(
      layoutModule,
      layoutParams,
      undefined,
      parentForLayout,
    );
    layoutMetadataPromises.push(metadataPromise);
    layoutViewportPromises.push(resolveModuleViewport(layoutModule, layoutParams));
    accumulatedMetadata = metadataPromise.then(async (metadataResult) =>
      metadataResult ? mergeMetadata([await parentForLayout, metadataResult]) : parentForLayout,
    );
    // This parent chain can reject before a page's generateMetadata awaits it.
    // The original metadataPromise remains in Promise.all below, so errors still
    // propagate while avoiding process-level unhandled rejections.
    void accumulatedMetadata.catch(() => null);
  }

  const pageParentPromise = accumulatedMetadata;
  const [layoutMetadataResults, layoutViewportResults, pageMetadata, pageViewport] =
    await Promise.all([
      Promise.all(layoutMetadataPromises),
      Promise.all(layoutViewportPromises),
      options.pageModule
        ? resolveModuleMetadata(
            options.pageModule,
            options.params,
            searchParamsObject,
            pageParentPromise,
          )
        : Promise.resolve(null),
      options.pageModule
        ? resolveModuleViewport(options.pageModule, options.params)
        : Promise.resolve(null),
    ]);

  const metadataList = [
    ...layoutMetadataResults.filter(isMetadata),
    ...(pageMetadata ? [pageMetadata] : []),
  ];
  const viewportList = [
    ...layoutViewportResults.filter(isViewport),
    ...(pageViewport ? [pageViewport] : []),
  ];

  return {
    hasSearchParams,
    metadata: metadataList.length > 0 ? mergeMetadata(metadataList) : null,
    searchParamsObject,
    viewport: mergeViewport(viewportList),
  };
}
