export function resolveAppServerActionRuntimeId(
  actionId: string,
  isEdgeRuntime: boolean,
  runtimeMap: Readonly<Record<string, string>>,
  isDev: boolean,
): string {
  if (!isEdgeRuntime) return actionId;
  const separatorIndex = actionId.lastIndexOf("#");
  if (separatorIndex === -1) return actionId;

  const referenceId = actionId.slice(0, separatorIndex);
  const exportName = actionId.slice(separatorIndex + 1);
  const mappedReferenceId = runtimeMap[referenceId];
  if (mappedReferenceId) return `${mappedReferenceId}#${exportName}`;

  if (isDev && !referenceId.includes("__vinext_app_runtime=")) {
    const querySeparator = referenceId.includes("?") ? "&" : "?";
    return `${referenceId}${querySeparator}__vinext_app_runtime=edge#${exportName}`;
  }

  return actionId;
}
