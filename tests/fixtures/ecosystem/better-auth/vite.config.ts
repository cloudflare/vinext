import { defineConfig } from "vite";
import vinext from "vinext";
import rsc from "@vitejs/plugin-rsc";

export default defineConfig({
  plugins: [
    vinext(),
    rsc({
      entries: {
        rsc: "virtual:vinext-rsc-entry",
        ssr: "virtual:vinext-app-ssr-entry",
        client: "virtual:vinext-app-browser-entry",
      },
    }),
  ],
  ssr: {
    // Force better-auth through Vite's transform pipeline so our next/* aliases
    // work when better-auth/next-js does import("next/headers")
    noExternal: ["better-auth"],
  },
});
