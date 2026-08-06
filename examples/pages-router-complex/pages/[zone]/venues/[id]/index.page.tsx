import type { GetServerSideProps } from "next/types";
import Head from "next/head";

import { meterServerProps } from "@atlas/beacon/meter-server-props";
import { markUncacheable } from "@atlas/edge-policy/policy";
import type { LiftedProps } from "@atlas/view/lifted-props";
import { ViewKind } from "@atlas/view/kind";
import { zoneFromRouteQuery } from "@atlas/zones/zone";

export type VenuePageProps = {
  venue: { id: string; name: string; zoneSlug: string };
  lifted: Pick<LiftedProps, "viewKind" | "renderedAtMs">;
};

const VenuePage = ({ venue }: VenuePageProps) => (
  <>
    <Head>
      <title>{`${venue.name} | atlas venues`}</title>
    </Head>
    <section data-testid="venue-view" data-venue-id={venue.id}>
      <h1>{venue.name}</h1>
      <p>Zone: {venue.zoneSlug}</p>
    </section>
  </>
);

const pageData: GetServerSideProps<VenuePageProps> = async (context) => {
  // Venue detail carries visitor-specific opening data — never cached.
  markUncacheable(context.res);

  const id = String(context.params?.id ?? "");
  if (!/^v\d+$/.test(id)) {
    return { notFound: true };
  }

  const zone = zoneFromRouteQuery(context.query);

  return {
    props: {
      venue: { id, name: `Venue ${id.slice(1)}`, zoneSlug: zone.slug },
      lifted: {
        viewKind: ViewKind.VENUE,
        renderedAtMs: Date.now(),
      },
    },
  };
};

export const getServerSideProps = meterServerProps(pageData);

export default VenuePage;
