/** Critique-portal endpoints, resolved from the environment at request time. */
export const readCritiquePortalSettings = (): { expressEndpoint: string } => ({
  expressEndpoint: process.env["ATLAS_CRITIQUE_EXPRESS_URL"] ?? "",
});
