import Image from "next/image";
import Script from "next/script";

import { DeskLayout } from "@atlas/workbench/desk-layout";
import { workbenchServerProps } from "@atlas/workbench/page-data";

const SWATCH =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%233a6ea5'/%3E%3C/svg%3E";

type MediaWindow = Window & { __ATLAS_MEDIA_SCRIPT__?: boolean };

/** Pulls in the next/image and next/script runtimes, which only pages load. */
const MediaDesk = () => (
  <DeskLayout desk="media" title="Media">
    <Image
      data-testid="media-swatch"
      src={SWATCH}
      alt="Swatch"
      width={64}
      height={64}
      unoptimized
    />
    <Script
      id="atlas-media-script"
      strategy="afterInteractive"
      onReady={() => {
        (window as MediaWindow).__ATLAS_MEDIA_SCRIPT__ = true;
      }}
    >
      {"window.__ATLAS_MEDIA_INLINE__ = true;"}
    </Script>
  </DeskLayout>
);

export const getServerSideProps = workbenchServerProps("media");

export default MediaDesk;
