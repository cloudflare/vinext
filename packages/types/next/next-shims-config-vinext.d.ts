/**
 * next.config options that vinext supports ahead of the vendored Next.js
 * declarations (from Next.js v16.4's config-shared.ts).
 */
import "@vinext/types/next/upstream/dist/server/config-shared";

declare module "@vinext/types/next/upstream/dist/server/config-shared" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- module augmentation requires interface merging
  interface ExperimentalConfig {
    /**
     * Passes a `RouterTransitionStartEvent` as the third argument of
     * `onRouterTransitionStart` in `instrumentation-client`.
     */
    instrumentationClientRouterTransitionEvents?: boolean;
  }

  // oxlint-disable-next-line typescript/consistent-type-definitions -- module augmentation requires interface merging
  interface NextConfig {
    /**
     * Module specifiers that are required for side effects on the client before
     * hydration, in array order, ahead of the user's `instrumentation-client.{ts,js}`.
     * Each entry may be a bare npm package name or a path relative to the project root.
     */
    instrumentationClientInject?: string[];
  }
}
