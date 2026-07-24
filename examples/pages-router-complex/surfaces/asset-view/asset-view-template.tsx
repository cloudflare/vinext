import Head from "next/head";
import Link from "next/link";

import type { AssetRecord } from "@atlas/graph-handle/ops";

export type AssetViewTemplateProps = {
  template: "standard" | "clip" | "pack";
  asset: AssetRecord;
  packContents?: string[];
  streamManifestUrl?: string;
};

/** Renders whichever template the branching page-data function selected. */
export const AssetViewTemplate = ({
  template,
  asset,
  packContents,
  streamManifestUrl,
}: AssetViewTemplateProps) => (
  <>
    <Head>
      <title>{`${asset.title} | atlas`}</title>
    </Head>
    <article data-testid="asset-view" data-template={template}>
      <h1>{asset.title}</h1>
      <p>{asset.summary}</p>
      <dl>
        <dt>Kind</dt>
        <dd data-testid="asset-kind">{asset.kind}</dd>
        <dt>Collection</dt>
        <dd>{asset.collection}</dd>
      </dl>

      {template === "clip" && streamManifestUrl && (
        <video data-testid="clip-player" data-manifest={streamManifestUrl} />
      )}

      {template === "pack" && packContents && (
        <ul data-testid="pack-contents">
          {packContents.map((ref) => (
            <li key={ref}>{ref}</li>
          ))}
        </ul>
      )}

      <Link href="/">Back to the front</Link>
    </article>
  </>
);
