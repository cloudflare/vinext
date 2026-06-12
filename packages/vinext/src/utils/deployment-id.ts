export const NEXT_DEPLOYMENT_ID_HEADER = "x-deployment-id";

export function getDeploymentId(): string | undefined {
  return process.env.__VINEXT_DEPLOYMENT_ID || process.env.NEXT_DEPLOYMENT_ID || undefined;
}

export function appendDeploymentIdQuery(value: string, deploymentId = getDeploymentId()): string {
  if (!deploymentId) return value;
  const hashIndex = value.indexOf("#");
  const url = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : value.slice(hashIndex);
  const parsed = new URL(url, "http://vinext.local");
  if (parsed.searchParams.has("dpl")) return value;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}dpl=${deploymentId}${fragment}`;
}

export function appendAssetDeploymentIdQuery(
  value: string,
  deploymentId = getDeploymentId(),
): string {
  const parsed = new URL(value, "http://vinext.local");
  if (!parsed.pathname.includes("/_next/static/")) return value;
  return appendDeploymentIdQuery(value, deploymentId);
}

export function applyDeploymentIdHeader(headers: Headers, deploymentId = getDeploymentId()): void {
  if (deploymentId) headers.set(NEXT_DEPLOYMENT_ID_HEADER, deploymentId);
}
