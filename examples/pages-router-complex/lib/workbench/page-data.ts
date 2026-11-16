import type { GetServerSideProps } from "next/types";

import { meterServerProps } from "@atlas/beacon/meter-server-props";
import { markUncacheable } from "@atlas/edge-policy/policy";
import type { PageLiftedProps } from "@atlas/view/lifted-props";
import { ViewKind } from "@atlas/view/kind";

/** The (metered, uncached) page data every workbench page exports. */
export const workbenchServerProps = (desk: string) => {
  const pageData: GetServerSideProps<PageLiftedProps> = async (context) => {
    markUncacheable(context.res);
    return {
      props: {
        lifted: { desk, viewKind: ViewKind.PLAIN, renderedAtMs: Date.now() },
      },
    };
  };
  return meterServerProps(pageData);
};
