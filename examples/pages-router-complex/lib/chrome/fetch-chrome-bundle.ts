import type { AppContext } from "next/app";

import { buildResultCache, HeapStore } from "../memo/memo-cache";
import type { Zone } from "../zones/zone";
import { zoneFromRouteQuery } from "../zones/zone";

export type ChromeContext = {
  zone: Zone;
  draft: boolean;
  credentialScope: string;
};

export type NavBranch = {
  label: string;
  href: string;
  children?: NavBranch[];
};

export type NavTree = {
  mintedAt: number;
  zone: string;
  draft: boolean;
  branches: NavBranch[];
};

export type AlphaIndex = {
  letters: string[];
};

export type ChromeBundle = {
  masthead: {
    navTree: NavTree | null;
    alphaIndex?: AlphaIndex;
    hideLookupOnMobile?: boolean;
  };
  baseboard: {
    linkSets: { title: string; rows: { text: string; href: string }[] }[];
  };
};

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Simulated upstream navigation-service call. */
export const fetchNavTree = async (ctx: ChromeContext): Promise<NavTree> => {
  await settle(10);
  return {
    mintedAt: Date.now(),
    zone: ctx.zone.slug,
    draft: ctx.draft,
    branches: [
      { label: "Skies", href: "/gallery/skies" },
      { label: "Tides", href: "/gallery/tides" },
      { label: "Forests", href: "/gallery/forests" },
      { label: "Journal", href: "/journal" },
    ],
  };
};

export const fetchAlphaIndex = async (_ctx: ChromeContext): Promise<AlphaIndex> => {
  await settle(5);
  return { letters: ["A", "B", "C"] };
};

export const fetchBaseboardLinks = async (ctx: ChromeContext) => {
  await settle(5);
  return {
    linkSets: [
      {
        title: "Help",
        rows: [
          { text: "About the atlas", href: "/journal/about" },
          { text: `Contact (${ctx.zone.slug})`, href: "/journal/contact" },
        ],
      },
    ],
  };
};

const loadNavPayloadFresh = async (ctx: ChromeContext) => {
  const [navTree, alphaIndex] = await Promise.all([
    fetchNavTree(ctx),
    fetchAlphaIndex(ctx),
  ]);

  return { navTree, alphaIndex };
};

const memoOnHeap = buildResultCache({
  store: new HeapStore(),
  registryName: "chrome-nav",
});

const loadNavPayload = memoOnHeap(loadNavPayloadFresh, {
  opName: "nav-tree",
  shouldStore: (payload) => !!payload.navTree,
  maxAgeSeconds: 60 * 5,
  deriveKey: (ctx) => [ctx.zone.id],
});

/**
 * The app shell's getInitialProps data source. Deliberately convoluted:
 *  - embedded-shell requests skip chrome entirely (returns undefined)
 *  - the zone comes from the *router* context, not the raw request
 *  - draft requests bypass the heap memo; everything else shares one
 *    memoised navigation payload per zone
 *  - navigation and baseboard fetches run concurrently
 */
export const fetchChromeBundle = async ({
  appCtx,
  credentialScope,
  insideShell,
}: {
  appCtx: AppContext;
  credentialScope: string;
  insideShell?: boolean;
}): Promise<ChromeBundle | undefined> => {
  if (insideShell) {
    return;
  }

  const ctx: ChromeContext = {
    zone: zoneFromRouteQuery(appCtx.router.query),
    draft: appCtx.router.isPreview,
    credentialScope: credentialScope.toUpperCase(),
  };

  const navPayloadPromise = ctx.draft
    ? loadNavPayloadFresh(ctx)
    : loadNavPayload(ctx);

  const [navPayload, baseboard] = await Promise.all([
    navPayloadPromise,
    fetchBaseboardLinks(ctx),
  ]);

  return {
    masthead: {
      navTree: navPayload.navTree,
      alphaIndex: navPayload.alphaIndex,
    },
    baseboard,
  };
};
