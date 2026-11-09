import { federation } from "@module-federation/vinext";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    federation({
      name: "remote",
      dts: false,
      exposes: {
        "./Counter": "./src/counter.tsx",
      },
    }),
    react(),
  ],
  build: { target: "chrome89" },
  preview: { cors: true, port: 4221, strictPort: true },
});
