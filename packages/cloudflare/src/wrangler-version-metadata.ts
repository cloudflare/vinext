export function assertCdnVersionMetadataConfig({
  binding,
  configuredBinding,
  configPath,
}: {
  binding: string;
  configuredBinding: string | undefined;
  configPath: string | undefined;
}): void {
  if (configuredBinding === binding) return;

  const location = configPath ? ` in ${configPath}` : "";
  const found = configuredBinding
    ? ` declares ${JSON.stringify(configuredBinding)} instead`
    : " does not declare version_metadata";
  throw new Error(
    `[vinext] Cloudflare CDN warmup requires version metadata binding ${JSON.stringify(binding)}, but the effective Wrangler config${location}${found}. Deploy the generated Wrangler config finalized by cdnAdapter(), or add the binding to this effective config and align cdnAdapter({ versionMetadataBinding }) when using a custom name.`,
  );
}
