import NextImage from "next/image";

import { mediaProxyLoader } from "../look/media-loader";
import styles from "./screen-art.module.css";

export type ScreenArtProps = {
  title: string;
  assetPath: string;
};

/**
 * Fault-screen hero artwork: next/image in `fill` mode with the custom media
 * proxy loader and a css-module class — the framework image pipeline is
 * exercised without ever touching `/_next/image`.
 */
export const ScreenArt = ({ title, assetPath }: ScreenArtProps) => (
  <div className={styles.frame} data-testid="screen-art">
    <NextImage
      className={styles.art}
      fill
      alt={title}
      src={assetPath}
      loader={mediaProxyLoader}
    />
  </div>
);
