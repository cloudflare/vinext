/**
 * Test-only outbound request stubbing, wired up through a conditional
 * top-level promise that the app shell re-exports. When the e2e harness sets
 * `STUB_OUTBOUND=1`, the server process patches global fetch before any page
 * data fetching happens; in every other environment the export stays
 * `undefined` and the stub module is never even loaded.
 */
export const outboundStub =
  typeof window === "undefined" && process.env?.["STUB_OUTBOUND"] === "1"
    ? (async () => {
        const { installOutboundStub } = await import("./install-outbound-stub");
        return installOutboundStub();
      })()
    : undefined;
