import { useState } from "react";

import type { GetServerSideProps, GetServerSidePropsContext } from "next";
import Head from "next/head";
import Link from "next/link";

import { meterServerProps } from "@atlas/beacon/meter-server-props";
import {
  audiencesForZone,
  fetchBroadcast,
  Syndication_BroadcastSlot as BroadcastSlot,
} from "@atlas/broadcasts/api";
import { ServerHtmlOnly } from "@atlas/blocks/server-html-only/server-html-only";
import {
  ARMED,
  CREDENTIAL_SCOPE,
  LAUNCH_TIMER_FLAG,
  PRODUCT,
} from "@atlas/fixed/product";
import {
  graphHandleOptionsFromEnv,
  openServerGraphHandle,
} from "@atlas/graph-handle/server";
import { buildResultCache, HeapStore } from "@atlas/memo/memo-cache";
import {
  fetchProvisioningOptions,
  provisioningCategory,
} from "@atlas/provisioning/api";
import { readServerSettings } from "@atlas/runtime-settings/settings";
import { useTrialArm } from "@atlas/trials/trials";
import type { PageLiftedProps } from "@atlas/view/lifted-props";
import { zoneFromRouteQuery } from "@atlas/zones/zone";

export type DiagnosticsProps = {
  settingsDump: unknown;
  memoStamp: string;
} & PageLiftedProps;

const Diagnostics = ({ settingsDump, memoStamp }: DiagnosticsProps) => {
  const [isPrimaryFlyoutOpen, setPrimaryFlyoutOpen] = useState(false);
  const [isSecondaryFlyoutOpen, setSecondaryFlyoutOpen] = useState(false);

  const launchTimerArm = useTrialArm(LAUNCH_TIMER_FLAG);

  const timerDeadline =
    launchTimerArm?.enabled && launchTimerArm?.armKey === ARMED
      ? (launchTimerArm.knobs?.["timer_deadline"] as string | undefined)
      : undefined;

  return (
    <>
      <Head>
        <title>atlas | diagnostics</title>
        <meta name="description" content="atlas fixture diagnostics page" />
      </Head>

      {timerDeadline && (
        <p data-testid="launch-timer" data-deadline={timerDeadline}>
          Launch timer armed
        </p>
      )}

      <ServerHtmlOnly>
        <p data-testid="crawler-note">Server-rendered crawler note</p>
      </ServerHtmlOnly>

      <h1>Atlas quick links</h1>
      <ul>
        <li>
          <Link href="/gallery/skies/clips" prefetch={false} legacyBehavior>
            <a href="/gallery/skies/clips">Skies clips wall</a>
          </Link>
        </li>
        <li>
          <Link href="/gallery/tides" prefetch={false} legacyBehavior>
            <a href="/gallery/tides">Tides wall</a>
          </Link>
        </li>
        <li>
          <Link href="/skies/item/1101" prefetch={false} legacyBehavior>
            <a href="/skies/item/1101">A clip asset</a>
          </Link>
        </li>
        <li>
          <Link href="/boxed-set/item/3001" prefetch={false} legacyBehavior>
            <a href="/boxed-set/item/3001">A pack asset</a>
          </Link>
        </li>
        <li>
          <Link onClick={() => setPrimaryFlyoutOpen(true)} href="#">
            Primary flyout
          </Link>
        </li>
        <li>
          <Link onClick={() => setSecondaryFlyoutOpen(true)} href="#">
            Secondary flyout
          </Link>
        </li>
      </ul>

      {isPrimaryFlyoutOpen && (
        <aside data-testid="primary-flyout">
          <button onClick={() => setPrimaryFlyoutOpen(false)}>close</button>
          Primary flyout content
        </aside>
      )}
      {isSecondaryFlyoutOpen && (
        <aside data-testid="secondary-flyout">
          <button onClick={() => setSecondaryFlyoutOpen(false)}>close</button>
          Secondary flyout content
        </aside>
      )}

      <h2>Draft mode</h2>
      <ul>
        <li>
          <a href="/api/draft">Enter draft mode</a>
        </li>
        <li>
          <a href="/api/draft?draft=off">Leave draft mode</a>
        </li>
      </ul>

      <h2>Runtime settings</h2>
      <pre data-testid="settings-dump">{JSON.stringify(settingsDump, null, 2)}</pre>

      <h2>Memo stamp</h2>
      <p data-testid="memo-stamp">{memoStamp}</p>
    </>
  );
};

const memoOnHeap = buildResultCache({
  store: new HeapStore(),
  registryName: "atlas:diagnostics",
});

const mintStamp = memoOnHeap(
  (probeKey: string) => ({ stamp: `${probeKey} @ ${Date.now()}` }),
  {
    opName: "stamp",
    maxAgeSeconds: 30,
    deriveKey: (probeKey) => probeKey,
    shouldStore: () => true,
  },
);

const pageData: GetServerSideProps<DiagnosticsProps> = async (
  ctx: GetServerSidePropsContext,
) => {
  const settings = readServerSettings();
  const handle = openServerGraphHandle(
    graphHandleOptionsFromEnv(process.env, {
      credentialScope: CREDENTIAL_SCOPE,
      handleName: PRODUCT,
    }),
  );

  const zone = zoneFromRouteQuery(ctx.query);

  const audiences = audiencesForZone(zone);

  const [tickerData, marqueeData, provisioningOptions] = await Promise.all([
    fetchBroadcast(handle, {
      slot: BroadcastSlot.Ticker,
      audiences,
      zone,
      draft: !!ctx.draftMode,
    }),
    fetchBroadcast(handle, {
      slot: BroadcastSlot.Marquee,
      audiences,
      zone,
      draft: !!ctx.draftMode,
    }),

    fetchProvisioningOptions(handle, {
      category: provisioningCategory(),
      zone,
      draft: ctx.draftMode,
    }),
  ]);

  const { stamp } = await mintStamp(JSON.stringify(ctx.query));

  return {
    props: {
      // JSON round-trip: strips undefined values (which getServerSideProps
      // refuses to serialise) along with the redacted secret.
      settingsDump: JSON.parse(
        JSON.stringify({ ...settings, purgeBearer: undefined }),
      ),
      memoStamp: stamp,
      lifted: {
        provisioningOptions,
        desk: "gallery/forests",
        renderedAtMs: new Date().getTime(),
        tickerData,
        marqueeData,
      },
    },
  };
};

export const getServerSideProps = meterServerProps(pageData);

export default Diagnostics;
