import type { OperationLane } from "./operation-token.js";

export function shouldPingVisibleLinksAfterMountedSlotsChange(options: {
  nextMountedSlotsHeader: string | null;
  operationLane: OperationLane | null;
  previousMountedSlotsHeader: string | null;
}): boolean {
  return (
    options.previousMountedSlotsHeader !== options.nextMountedSlotsHeader &&
    options.operationLane !== "traverse"
  );
}
