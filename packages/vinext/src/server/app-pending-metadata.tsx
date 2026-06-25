import type { ReactNode } from "react";
import { MetadataHead, renderMetadataToHtml } from "vinext/shims/metadata";
import type { AppPendingMetadata } from "./app-elements.js";

export type AppPendingMetadataPlacement = "body" | "head";

export async function PendingAppMetadata({
  pendingMetadata,
  placement,
}: {
  pendingMetadata: AppPendingMetadata;
  placement: Promise<AppPendingMetadataPlacement>;
}): Promise<ReactNode> {
  const resolvedPlacement = await placement;
  if (resolvedPlacement === "head") {
    return (
      <MetadataHead
        metadata={pendingMetadata.metadata}
        pathname={pendingMetadata.pathname}
        trailingSlash={pendingMetadata.trailingSlash}
      />
    );
  }

  return (
    <div
      hidden
      data-vinext-pending-metadata="body"
      dangerouslySetInnerHTML={{
        __html: renderMetadataToHtml(pendingMetadata.metadata, pendingMetadata.pathname, {
          trailingSlash: pendingMetadata.trailingSlash,
        }),
      }}
    />
  );
}
