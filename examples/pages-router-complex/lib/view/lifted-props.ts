import type { PrefetchedGraphState } from "../graph-handle/prefetch-state";
import type { ViewKind } from "./kind";

export type BroadcastPayload = {
  slot: string;
  message: string;
  draft?: boolean;
} | null;

export type ProvisioningOption = {
  key: string;
  zoneId: string;
};

/**
 * Props that individual pages "lift" up to the shared frame via a reserved
 * `lifted` key on their page props. The app shell plucks these out of
 * pageProps and threads them into ProviderShell/ChromeFrame, so a leaf page
 * controls chrome-level concerns (tickers, view typing, frame width) from
 * its getServerSideProps.
 */
export type LiftedProps = {
  provisioningOptions?: ProvisioningOption[] | null;
  tickerData?: BroadcastPayload;
  marqueeData?: BroadcastPayload;
  desk?: string;
  viewKind?: ViewKind;
  templateKind?: string;
  galleryPath?: string;
  renderedAtMs: number;
  seedTrialAttributes?: Record<string, unknown>;
};

export type PageLiftedProps = {
  lifted: LiftedProps;
  graphSnapshot?: PrefetchedGraphState;
  edgeProbeData?: Record<string, unknown>;
};
