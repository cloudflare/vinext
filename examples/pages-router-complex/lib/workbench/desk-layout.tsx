import type { ReactNode } from "react";

import Head from "next/head";

import { ZonedLink } from "@atlas/zones/zoned-link";

import { useHydrated } from "./use-hydrated";

export const DESKS = [
  { slug: "ledger", label: "Ledger" },
  { slug: "roster", label: "Roster" },
  { slug: "dispatch", label: "Dispatch" },
  { slug: "inventory", label: "Inventory" },
  { slug: "reports", label: "Reports" },
  { slug: "tools", label: "Tools" },
  { slug: "media", label: "Media" },
  { slug: "search", label: "Search" },
] as const;

/** The workbench chrome every workbench page renders inside. */
export const DeskLayout = ({
  desk,
  title,
  children,
}: {
  desk: string;
  title: string;
  children: ReactNode;
}) => {
  const hydrated = useHydrated();
  return (
    <>
      <Head>
        <title>{`${title} | atlas workbench`}</title>
      </Head>
      <section data-testid="workbench-desk" data-desk={desk} data-hydrated={hydrated}>
        <nav aria-label="Workbench desks">
          <ZonedLink href="/workbench">Workbench</ZonedLink>
          {DESKS.map((entry) => (
            <ZonedLink
              key={entry.slug}
              href={`/workbench/${entry.slug}`}
              data-testid={`desk-link-${entry.slug}`}
            >
              {entry.label}
            </ZonedLink>
          ))}
        </nav>
        <h1>{title}</h1>
        {children}
      </section>
    </>
  );
};
