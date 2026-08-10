import { useEffect } from "react";

import { emitBeacon } from "../../beacon/emit";

export const useShellTelemetry = ({
  renderedAtMs,
  isEmbedded,
  viewKind,
  templateKind,
}: {
  renderedAtMs?: number;
  isEmbedded: boolean;
  viewKind?: string;
  templateKind?: string;
}): void => {
  useEffect(() => {
    emitBeacon("shell-info", {
      renderedAtMs,
      isEmbedded,
      viewKind,
      templateKind,
    });
  }, [renderedAtMs, isEmbedded, viewKind, templateKind]);
};
