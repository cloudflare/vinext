import Link from "next/link";
import { useTranslation } from "react-i18next";

import type { ChromeBundle } from "../../chrome/fetch-chrome-bundle";
import { PRIMARY_REGION_ID } from "../../fixed/product";
import type { LiftedProps } from "../../view/lifted-props";
import { ViewKind } from "../../view/kind";
import { useRuntimeSettings } from "../../wiring/runtime-settings-context";
import { useEdgeProbe } from "../../wiring/stack";
import { useAudienceZone } from "../../zones/use-audience-zone";
import { ZonedLink } from "../../zones/zoned-link";
import { RouteProgress } from "../route-progress/route-progress";
import { allowsFullBleed } from "./allows-full-bleed";
import styles from "./chrome-frame.module.css";

export type ChromeFrameProps = {
  children: React.ReactNode;
  mastheadProps?: ChromeBundle["masthead"];
  baseboardProps?: ChromeBundle["baseboard"];
  lifted?: LiftedProps;
  isEmbedded?: boolean;
};

export const EDGE_PROBE_MASTHEAD_VARIANT_A = 8801;
export const EDGE_PROBE_MASTHEAD_VARIANT_B = 8802;

export const ChromeFrame = ({
  children,
  mastheadProps,
  baseboardProps,
  lifted,
  isEmbedded,
}: ChromeFrameProps) => {
  const zone = useAudienceZone();
  const { dataEdge } = useRuntimeSettings();
  const { t } = useTranslation("chrome");
  const { hasActiveProbe } = useEdgeProbe();
  const hasAlternateMasthead =
    hasActiveProbe(EDGE_PROBE_MASTHEAD_VARIANT_A) ||
    hasActiveProbe(EDGE_PROBE_MASTHEAD_VARIANT_B);

  const isDetailView = lifted?.viewKind === ViewKind.DETAIL;
  const fullBleed = allowsFullBleed(lifted?.viewKind);

  return (
    <div className={isDetailView ? styles.focusLayout : undefined}>
      {mastheadProps?.navTree && !isEmbedded && (
        <header
          className={styles.masthead}
          data-testid="frame-masthead"
          data-zone={zone.slug}
          data-alternate={hasAlternateMasthead || undefined}
          data-nav-minted-at={mastheadProps.navTree.mintedAt}
        >
          <a href={`#${PRIMARY_REGION_ID}`}>
            {t("skipLink", "Skip to primary region")}
          </a>
          <nav aria-label="Primary">
            {mastheadProps.navTree.branches.map((branch) => (
              <ZonedLink key={branch.href} href={branch.href} prefetch={false}>
                {branch.label}
              </ZonedLink>
            ))}
          </nav>
          {!mastheadProps.hideLookupOnMobile && (
            <form action="/lookup" data-testid="masthead-lookup">
              <input
                name="term"
                aria-label={t("lookupLabel", "Look something up")}
              />
            </form>
          )}
        </header>
      )}
      <main
        id={PRIMARY_REGION_ID}
        className={fullBleed ? styles.fullBleed : undefined}
      >
        {lifted?.tickerData && (
          <aside data-testid="frame-ticker" data-edge-url={dataEdge.url}>
            {lifted.tickerData.message}
          </aside>
        )}
        {lifted?.marqueeData && (
          <aside data-testid="frame-marquee">{lifted.marqueeData.message}</aside>
        )}
        <RouteProgress>{children}</RouteProgress>
      </main>

      {baseboardProps && !isEmbedded && (
        <footer className={styles.baseboard} data-testid="frame-baseboard">
          {baseboardProps.linkSets.map((set) => (
            <section key={set.title}>
              <h2>{set.title}</h2>
              <ul>
                {set.rows.map((row) => (
                  <li key={row.href}>
                    <ZonedLink href={row.href}>{row.text}</ZonedLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </footer>
      )}
    </div>
  );
};
