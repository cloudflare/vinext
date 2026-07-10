export type WranglerConfigFormat = "json" | "toml";

/** Facts about an updated Wrangler config that `init-cloudflare.ts` needs, independent of source format. */
export type WranglerConfigUpdateFacts = {
  imagesBinding: string;
  needsKvNamespaceId: boolean;
};

export type ExistingWranglerConfigUpdatePlan = WranglerConfigUpdateFacts & {
  path: string;
  fileName: string;
  code: string;
  changed: boolean;
};
