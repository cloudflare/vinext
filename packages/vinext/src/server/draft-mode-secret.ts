let draftModeSecret: string | null = null;

export function setDraftModeSecret(secret: string): void {
  if (secret.length === 0) {
    throw new Error("[vinext] draft mode secret must be a non-empty string.");
  }
  draftModeSecret = secret;
}

export function getDraftModeSecret(): string {
  if (draftModeSecret !== null) {
    return draftModeSecret;
  }

  throw new Error(
    "[vinext] draft mode secret is not initialized. " +
      "This should be initialized by the server entry before handling requests.",
  );
}
