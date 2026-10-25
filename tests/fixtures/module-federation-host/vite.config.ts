import { federation } from "@module-federation/vinext";
import { defineConfig } from "vite";
import vinext from "vinext";

// Mirrors the host configuration from the Module Federation guide.
export default defineConfig({
  plugins: [
    federation({
      name: "host",
      dts: false,
      remotes: {
        remote: {
          type: "module",
          name: "remote",
          entry: "http://localhost:4221/remoteEntry.js",
          entryGlobalName: "remote",
          shareScope: "default",
        },
      },
    }),
    vinext(),
  ],
});
