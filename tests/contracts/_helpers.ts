import { startFixtureServer, APP_FIXTURE_DIR, type TestServerResult } from "../helpers";

let server: TestServerResult | null = null;

/**
 * Get or create the shared contract test server.
 * Uses the existing app-basic fixture.
 */
export async function getContractServer(): Promise<TestServerResult> {
  // Allow overriding with an external URL for future prod testing
  if (process.env.CONTRACT_TARGET_URL) {
    return { server: null as any, baseUrl: process.env.CONTRACT_TARGET_URL };
  }

  if (!server) {
    server = await startFixtureServer(APP_FIXTURE_DIR);
  }
  return server;
}

export async function closeContractServer(): Promise<void> {
  if (server && !process.env.CONTRACT_TARGET_URL) {
    await server.server.close();
    server = null;
  }
}
