import { vi } from "vite-plus/test";

// Unit tests run without the `react-server` condition, so plugin-rsc's Flight
// entry cannot load. Give every unit test the real installed codec instead.
vi.mock("@vitejs/plugin-rsc/react/rsc", async () => {
  const { loadCacheFlightCodec } = await import("../helpers/cache-flight-codec.js");
  return loadCacheFlightCodec();
});
