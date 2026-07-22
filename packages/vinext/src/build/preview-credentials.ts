import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type PreviewBuildCredentials = {
  id: string;
  signingKey: string;
  encryptionKey: string;
};

const previewBuildCredentialsStorage = new AsyncLocalStorage<PreviewBuildCredentials>();

export function createPreviewBuildCredentials(): PreviewBuildCredentials {
  return {
    id: randomBytes(16).toString("hex"),
    signingKey: randomBytes(32).toString("hex"),
    encryptionKey: randomBytes(32).toString("hex"),
  };
}

export function getPreviewBuildCredentials(): PreviewBuildCredentials | undefined {
  return previewBuildCredentialsStorage.getStore();
}

export function runWithPreviewBuildCredentials<T>(callback: () => T): T {
  return previewBuildCredentialsStorage.run(createPreviewBuildCredentials(), callback);
}
