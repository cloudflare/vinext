import type { ComponentProps } from "react";

import Link from "next/link";

import { useAudienceZone } from "./use-audience-zone";
import { HOME_ZONE, isKnownZone } from "./zone";
import type { Zone } from "./zone";

/** Service paths are owned by other systems and never zone-prefixed. */
const isServicePath = (href: string) =>
  href.startsWith("/api/") || href.startsWith("/legacy/");

export const zonedHref = (href: string, zone: Zone): string => {
  if (!href.startsWith("/") || href.startsWith("//") || isServicePath(href)) {
    return href;
  }
  const firstSegment = href.split("/")[1];
  const bare = isKnownZone(firstSegment)
    ? href.slice(firstSegment!.length + 1) || "/"
    : href;
  if (zone.slug === HOME_ZONE.slug) {
    return bare;
  }
  return bare === "/" ? `/${zone.slug}` : `/${zone.slug}${bare}`;
};

type ZonedLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  href: string;
};

/** next/link wrapper that keeps visitors inside their audience zone. */
export const ZonedLink = ({ href, ...rest }: ZonedLinkProps) => {
  const zone = useAudienceZone();
  return <Link {...rest} href={zonedHref(href, zone)} />;
};
