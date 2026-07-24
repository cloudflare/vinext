import { useState } from "react";

import Head from "next/head";
import { I18nextProvider } from "react-i18next";

import { readCookie } from "../../client-state/cookies";
import { PRODUCT } from "../../fixed/product";
import type { PrefetchedGraphState } from "../../graph-handle/prefetch-state";
import {
  GraphHandleProvider,
  useBrowserGraphHandle,
} from "../../graph-handle/react";
import type { PublicSettings } from "../../runtime-settings/settings";
import { TrialsProvider, useTrialsBeacon } from "../../trials/trials";
import type { ViewKind } from "../../view/kind";
import { guessViewKind } from "../../view/kind";
import { ClientEnvProvider } from "../../wiring/client-env";
import type { RuntimeSettingsValue } from "../../wiring/runtime-settings-context";
import { RuntimeSettingsProvider } from "../../wiring/runtime-settings-context";
import {
  CritiquePortalProvider,
  EdgeProbeProvider,
  SidePanelProvider,
  SignInStateProvider,
  useEngageKit,
  ViewportBandProvider,
} from "../../wiring/stack";
import { createCopyRuntime } from "../../zones/i18n";
import { useAudienceZone } from "../../zones/use-audience-zone";
import { useShellTelemetry } from "./use-shell-telemetry";

export type ProviderShellProps = {
  children: React.ReactNode;
  settings: PublicSettings;
  critiqueSettings?: { expressEndpoint: string };
  graphSnapshot?: PrefetchedGraphState;
  renderedAtMs?: number;
  isEmbedded?: boolean;
  viewKind?: ViewKind;
  templateKind?: string;
  edgeProbeData?: Record<string, unknown>;
  seedTrialAttributes?: Record<string, unknown>;
  lookupApiKey?: string;
  gatewayRest?: {
    baseUrl: string;
    apiKey: string;
  };
};

/**
 * The provider pyramid. The nesting order is deliberate — several providers
 * read from the ones above them.
 */
export const ProviderShell = ({
  children,
  settings,
  graphSnapshot,
  renderedAtMs,
  isEmbedded = false,
  viewKind = guessViewKind(),
  templateKind,
  edgeProbeData = {},
  seedTrialAttributes = {},
  lookupApiKey = "",
  gatewayRest,
  critiqueSettings = {
    expressEndpoint: "",
  },
}: ProviderShellProps) => {
  const zone = useAudienceZone();

  // One i18next runtime per tree: created for the zone's language, never
  // recreated across renders.
  const [copyRuntime] = useState(() => createCopyRuntime(zone.language));

  useEngageKit({
    product: PRODUCT,
    engageSettings: {
      appId: settings.engage?.appId,
      apiKey: settings.engage?.apiKey,
    },
  });

  const graphHandle = useBrowserGraphHandle({
    settings,
    handleName: `${PRODUCT}-${viewKind}`,
    graphSnapshot,
  });

  useShellTelemetry({ renderedAtMs, isEmbedded, viewKind, templateKind });

  useTrialsBeacon({
    product: PRODUCT,
    active: !!settings.trialsSnippetId && readCookie("mute-trials") !== "true",
  });

  const runtimeSettingsValue: RuntimeSettingsValue = {
    ...settings,
    lookupApiKey,
    gatewayRest,
  };

  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Fixes hydration issues caused by the Safari phone number detection */}
        <meta name="format-detection" content="telephone=no" />
      </Head>

      <ClientEnvProvider isEmbedded={isEmbedded}>
        <SignInStateProvider withSessionBridge surfaceFaults>
          <I18nextProvider i18n={copyRuntime}>
            <ViewportBandProvider>
              <RuntimeSettingsProvider value={runtimeSettingsValue}>
                <CritiquePortalProvider
                  settings={{
                    expressEndpoint: critiqueSettings.expressEndpoint,
                    gatewayRest: {
                      baseUrl: gatewayRest?.baseUrl ?? "",
                      apiKey: gatewayRest?.apiKey ?? "",
                    },
                  }}
                >
                  <GraphHandleProvider value={graphHandle}>
                    <EdgeProbeProvider data={edgeProbeData}>
                      <TrialsProvider
                        seedAttributes={{
                          "is-embedded": isEmbedded,
                          product: PRODUCT,
                          ...seedTrialAttributes,
                        }}
                      >
                        <SidePanelProvider dataEdgeUrl={settings.dataEdge.url}>
                          {children}
                        </SidePanelProvider>
                      </TrialsProvider>
                    </EdgeProbeProvider>
                  </GraphHandleProvider>
                </CritiquePortalProvider>
              </RuntimeSettingsProvider>
            </ViewportBandProvider>
          </I18nextProvider>
        </SignInStateProvider>
      </ClientEnvProvider>
    </>
  );
};
