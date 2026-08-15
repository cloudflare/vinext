/** REST gateway credentials, resolved from the environment at request time. */
export const readGatewayRestSettings = (): {
  baseUrl: string;
  apiKey: string;
} => ({
  baseUrl: process.env["ATLAS_GATEWAY_REST_URL"] ?? "",
  apiKey: process.env["ATLAS_GATEWAY_REST_KEY"] ?? "",
});
