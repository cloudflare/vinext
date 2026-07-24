import { useState } from "react";

import type { GetServerSideProps } from "next";
import Head from "next/head";
import { usePathname, useSearchParams } from "next/navigation";

import { meterServerProps } from "@atlas/beacon/meter-server-props";
import { applyCachePolicy } from "@atlas/edge-policy/policy";
import type { PageLiftedProps } from "@atlas/view/lifted-props";
import { ViewKind } from "@atlas/view/kind";

/**
 * Deliberate hybrid: an App Router navigation hook (`useSearchParams`) reads
 * the *initial* query inside a Pages Router page, and subsequent filter
 * changes bypass the router entirely by writing
 * `window.history.replaceState` — so `router.query` and the address bar
 * intentionally drift apart until the next real navigation.
 */

const setDeskInUrl = (selectedDesk: string) => {
  const queryParams = new URLSearchParams(window.location.search);
  queryParams.set("desk", selectedDesk);
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}?${queryParams}`,
  );
};

type DirectoryRow = {
  name: string;
  desk: string;
};

export type DirectoryPageProps = PageLiftedProps & {
  rows: DirectoryRow[];
  desks: string[];
};

export type DirectoryComponentProps = Omit<
  DirectoryPageProps,
  "lifted" | "graphSnapshot" | "edgeProbeData"
>;

const DirectoryAToZ = ({ rows, desks }: DirectoryComponentProps) => {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const initialDesk = searchParams.get("desk") || "all";
  const [desk, setDesk] = useState(initialDesk);

  const visibleRows =
    desk === "all" ? rows : rows.filter((row) => row.desk === desk);

  return (
    <>
      <Head>
        <title>Directory A–Z | atlas</title>
      </Head>
      <section
        data-testid="directory-a-z"
        data-desk={desk}
        data-pathname={pathname ?? undefined}
      >
        <h1>Directory A–Z</h1>
        <label>
          Desk
          <select
            data-testid="desk-filter"
            value={desk}
            onChange={(event) => {
              setDesk(event.target.value);
              setDeskInUrl(event.target.value);
            }}
          >
            <option value="all">all</option>
            {desks.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <ul>
          {visibleRows.map((row) => (
            <li key={row.name}>{row.name}</li>
          ))}
        </ul>
      </section>
    </>
  );
};

const pageData: GetServerSideProps<DirectoryPageProps> = async (context) => {
  applyCachePolicy({
    res: context.res,
    surrogateSeconds: 7200,
    browserSeconds: 600,
  });

  const desks = ["skies", "tides", "forests"];

  return {
    props: {
      desks,
      rows: desks.flatMap((deskName) =>
        Array.from({ length: 2 }, (_, i) => ({
          name: `${deskName[0].toUpperCase()}${deskName.slice(1)} listing ${i + 1}`,
          desk: deskName,
        })),
      ),
      lifted: {
        viewKind: ViewKind.PLAIN,
        renderedAtMs: Date.now(),
      },
    },
  };
};

export const getServerSideProps = meterServerProps(pageData);

export default DirectoryAToZ;
