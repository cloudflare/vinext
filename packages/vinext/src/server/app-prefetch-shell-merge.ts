import { AppElementsWire, type AppElements, type AppElementValue } from "./app-elements.js";

/**
 * Reconstitute a complete dynamic-on-hover payload from the static shell that
 * preceded it and the server's skip-pruned dynamic response.
 *
 * Only layouts explicitly named by the dynamic response may be copied. Any
 * skipped id absent from the shell remains in the metadata so the normal
 * mounted-state preservation path can handle it conservatively.
 */
export function mergeDynamicPrefetchWithShell(
  shell: AppElements,
  dynamic: AppElements,
): AppElements {
  const skippedLayoutIds = AppElementsWire.readMetadata(dynamic).skippedLayoutIds;
  if (skippedLayoutIds.length === 0) return dynamic;

  const merged: Record<string, AppElementValue> = { ...dynamic };
  const remainingSkippedLayoutIds: string[] = [];
  for (const layoutId of skippedLayoutIds) {
    if (Object.hasOwn(shell, layoutId)) {
      merged[layoutId] = shell[layoutId];
    } else {
      remainingSkippedLayoutIds.push(layoutId);
    }
  }

  if (remainingSkippedLayoutIds.length === 0) {
    delete merged[AppElementsWire.keys.skippedLayoutIds];
  } else {
    merged[AppElementsWire.keys.skippedLayoutIds] = remainingSkippedLayoutIds;
  }
  return merged;
}
