import type { AppContext } from "next/app";

import { emitBeacon } from "@atlas/beacon/emit";
import type { ChromeBundle } from "@atlas/chrome/fetch-chrome-bundle";
import { fetchChromeBundle } from "@atlas/chrome/fetch-chrome-bundle";
import { insideAppShell } from "@atlas/client-state/cookies";
import { readCritiquePortalSettings } from "@atlas/critique/settings";
import { runningInBrowser } from "@atlas/env/runtime";
import { CREDENTIAL_SCOPE } from "@atlas/fixed/product";
import { readGatewayRestSettings } from "@atlas/gateway/settings";
import { readPublicSettingsForData } from "@atlas/runtime-settings/settings";

export type ShellInitialProps = {
  shellProps: {
    mastheadProps?: ChromeBundle["masthead"];
    baseboardProps?: ChromeBundle["baseboard"];

    settings: ReturnType<typeof readPublicSettingsForData>;
    isEmbedded: boolean;
    critiqueSettings: ReturnType<typeof readCritiquePortalSettings>;
    gatewayRest: ReturnType<typeof readGatewayRestSettings>;
    lookupApiKey?: string;
  };
};

/**
 * App-level getInitialProps. Having this on the shell at all is the point:
 * it forces every page through one shared server data path (and re-runs on
 * every client-side navigation, which the beacon below makes observable).
 */
export const buildShellInitialProps = async (
  appCtx: AppContext,
): Promise<ShellInitialProps> => {
  const settings = readPublicSettingsForData();

  const isEmbedded = insideAppShell(appCtx.ctx);

  const chromeBundle = await fetchChromeBundle({
    appCtx,
    credentialScope: CREDENTIAL_SCOPE,
    insideShell: isEmbedded,
  });

  runningInBrowser() &&
    emitBeacon("shell-props-client-refetch", {
      priorUrl: appCtx.ctx.asPath,
    });

  const masthead = chromeBundle?.masthead
    ? {
        ...chromeBundle.masthead,
        // The lookup view renders its own search box; hide the masthead one.
        hideLookupOnMobile: appCtx.router.asPath.startsWith("/lookup"),
      }
    : undefined;

  return {
    shellProps: {
      mastheadProps: masthead,
      baseboardProps: chromeBundle?.baseboard,
      settings,
      isEmbedded,
      lookupApiKey: process.env["ATLAS_LOOKUP_API_KEY"],
      critiqueSettings: readCritiquePortalSettings(),
      gatewayRest: readGatewayRestSettings(),
    },
  };
};
