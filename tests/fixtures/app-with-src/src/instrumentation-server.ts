import "server-only";

let initialized = false;

export function initialize(): void {
  initialized = true;
}

export function isInitialized(): boolean {
  return initialized;
}
