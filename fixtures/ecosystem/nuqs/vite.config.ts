import { defineConfig } from "vite";
import nextcompat from "vite-plugin-nextcompat";
import rsc from "@vitejs/plugin-rsc";

export default defineConfig({
  plugins: [
    nextcompat(),
    rsc({
      entries: {
        rsc: "virtual:nextcompat-rsc-entry",
        ssr: "virtual:nextcompat-app-ssr-entry",
        client: "virtual:nextcompat-app-browser-entry",
      },
    }),
  ],
  ssr: {
    // Force nuqs through Vite's transform pipeline so our next/* aliases work
    noExternal: ["nuqs"],
  },
});
