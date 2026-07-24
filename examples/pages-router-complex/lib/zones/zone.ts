export type Zone = {
  /** Internal zone identifier used by data services. */
  id: string;
  /** URL segment for the zone. */
  slug: string;
  /** BCP-47 language tag served to this zone (drives the i18next runtime). */
  language: string;
  tzName: string;
};

export const AudienceZone: Record<"NA" | "CA", Zone> = {
  NA: {
    id: "Z1",
    slug: "us",
    language: "en-US",
    tzName: "America/New_York",
  },
  CA: {
    id: "Z2",
    slug: "ca",
    language: "en-CA",
    tzName: "America/Toronto",
  },
};

const ALL_ZONES = Object.values(AudienceZone);

export const HOME_ZONE = AudienceZone.NA;

export const isKnownZone = (slug: string | undefined): boolean =>
  ALL_ZONES.some((zone) => zone.slug === slug);

/** Route-param → zone, defaulting to the home zone for anything unknown. */
export const zoneFromRouteQuery = (query: {
  zone?: string | string[];
}): Zone => {
  const slug = Array.isArray(query.zone) ? query.zone[0] : query.zone;
  return ALL_ZONES.find((zone) => zone.slug === slug) ?? HOME_ZONE;
};

export const htmlLangFor = (language: string): string =>
  language.split("-")[0] ?? language;
