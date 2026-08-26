import { getOrCreateAls } from "./internal/als-registry.js";

const trackingAls = getOrCreateAls<boolean>("vinext.cacheComponents.platformIo.tracking");

export function isPlatformIoTrackingActive(): boolean {
  return trackingAls.getStore() === true;
}

export function runWithPlatformIoTracking<T>(fn: () => T): T {
  return trackingAls.run(true, fn);
}

/** Framework bookkeeping must not make user output appear request-dependent. */
export function runWithoutPlatformIoTracking<T>(fn: () => T): T {
  return trackingAls.run(false, fn);
}
