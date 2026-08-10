import "@atlas/polyfills/focus-ring";
import "../styles/base.css";

import { useEffect } from "react";

import type { AppProps } from "next/app";
import dynamic from "next/dynamic";

import { ChromeFrame } from "@atlas/blocks/chrome-frame/chrome-frame";
import CrashGuard from "@atlas/blocks/crash-guard/crash-guard";
import { DraftBadge } from "@atlas/blocks/draft-badge/draft-badge";
import { ProviderShell } from "@atlas/blocks/provider-shell/provider-shell";
import { TagsScript } from "@atlas/blocks/tags-script/tags-script";
import { rearmTrials } from "@atlas/trials/trials";
import type { PageLiftedProps } from "@atlas/view/lifted-props";
import { useBeaconConsent } from "@atlas/wiring/stack";

import type { ShellInitialProps } from "./shell-initial-props";
import { buildShellInitialProps } from "./shell-initial-props";

const HelperDock = dynamic(
  () =>
    import("@atlas/blocks/helper-dock/helper-dock").then((m) => m.HelperDock),
  { ssr: false },
);

export { outboundStub } from "@atlas/outbound-stub/outbound-stub";

type HardNavProps = {
  hardNavTo?: string;
};

const App = ({
  Component,
  pageProps,
  shellProps,
  hardNavTo,
}: AppProps<PageLiftedProps | undefined> & ShellInitialProps & HardNavProps) => {
  useBeaconConsent();

  useEffect(() => {
    rearmTrials();
  }, []);

  if (hardNavTo) {
    window.location.assign(`${window.location.origin}${hardNavTo}`);
    return;
  }
  const {
    mastheadProps,
    baseboardProps,
    settings,
    isEmbedded,
    lookupApiKey,
    gatewayRest,
    critiqueSettings,
  } = shellProps;
  const { lifted, graphSnapshot, edgeProbeData } = pageProps ?? {};

  return (
    <CrashGuard
      viewKind={lifted?.viewKind ?? "atlas"}
      templateKind={lifted?.templateKind}
    >
      <TagsScript src={settings.tagsScriptUrl} />
      <ProviderShell
        settings={settings}
        isEmbedded={isEmbedded}
        graphSnapshot={graphSnapshot}
        renderedAtMs={lifted?.renderedAtMs}
        viewKind={lifted?.viewKind}
        templateKind={lifted?.templateKind}
        edgeProbeData={edgeProbeData}
        seedTrialAttributes={lifted?.seedTrialAttributes}
        lookupApiKey={lookupApiKey}
        gatewayRest={gatewayRest}
        critiqueSettings={critiqueSettings}
      >
        <DraftBadge />
        <ChromeFrame
          mastheadProps={mastheadProps}
          baseboardProps={baseboardProps}
          lifted={lifted}
          isEmbedded={isEmbedded}
        >
          <Component {...pageProps} />
        </ChromeFrame>
        <HelperDock />
      </ProviderShell>
    </CrashGuard>
  );
};

App.getInitialProps = buildShellInitialProps;

export default App;
