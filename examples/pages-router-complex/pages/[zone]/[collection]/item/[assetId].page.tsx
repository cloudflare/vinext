import type { GetServerSideProps } from "next";

import { meterServerProps } from "@atlas/beacon/meter-server-props";
import { CREDENTIAL_SCOPE, PRODUCT } from "@atlas/fixed/product";
import type { AssetRecord } from "@atlas/graph-handle/ops";
import { prefetchStore } from "@atlas/graph-handle/prefetch-state";
import {
  graphHandleOptionsFromEnv,
  openServerGraphHandle,
} from "@atlas/graph-handle/server";
import type { PageLiftedProps } from "@atlas/view/lifted-props";
import { ViewKind } from "@atlas/view/kind";

import { AssetViewTemplate } from "../../../../surfaces/asset-view/asset-view-template";

type TemplateName = "standard" | "clip" | "pack";

export type AssetViewProps = PageLiftedProps & {
  template: TemplateName;
  asset: AssetRecord;
  packContents?: string[];
  streamManifestUrl?: string;
};

export type PageProps = AssetViewProps;

/** The record's own kind picks the template; URLs carry no type hints. */
const TEMPLATE_BY_KIND: Record<string, TemplateName> = {
  clip: "clip",
  pack: "pack",
};

/**
 * Branch-heavy page data: id-shape validation, a catalogue miss and a
 * withdrawn record both 404, then per-template extras are attached based on
 * what the record says it is.
 */
const pageData: GetServerSideProps<PageProps> = async (context) => {
  const assetId = String(context.params?.assetId ?? "");
  if (!/^\d+$/.test(assetId)) {
    return { notFound: true };
  }

  const prefetch = prefetchStore({ browser: false });
  const handle = openServerGraphHandle({
    ...graphHandleOptionsFromEnv(process.env, {
      credentialScope: CREDENTIAL_SCOPE,
      handleName: `${PRODUCT}-detail`,
    }),
    prefetch,
  });

  const record = await handle.run<AssetRecord | null>("assetById", { assetId });
  if (!record || record.retiredOn) {
    return { notFound: true };
  }

  const template = TEMPLATE_BY_KIND[record.kind] ?? "standard";

  const extras =
    template === "clip"
      ? {
          streamManifestUrl: `https://media.atlas-fixture.test/streams/${assetId}.m3u8`,
        }
      : template === "pack"
        ? { packContents: record.bundle ?? [] }
        : {};

  return {
    props: {
      template,
      asset: record,
      ...extras,
      graphSnapshot: prefetch.snapshot(),
      lifted: {
        viewKind: ViewKind.DETAIL,
        templateKind: template,
        renderedAtMs: Date.now(),
      },
    },
  };
};

const Page = (props: PageProps) => {
  return <AssetViewTemplate {...props} />;
};

export const getServerSideProps = meterServerProps(pageData);

export default Page;
