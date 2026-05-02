import { defineConfig } from "vite-plus";
import vinext from "vinext";
import tailwindcss from "@tailwindcss/vite";
import mdx from 'fumadocs-mdx/vite';
import * as MdxConfig from './source.config.js';

export default defineConfig({
  // we do this to avoid Vite from bundling React contexts and cause duplicated contexts conflicts.
  optimizeDeps: {
    exclude: [
      'fumadocs-ui',
      'fumadocs-core',
    ],
    include: [
      'fumadocs-ui > debug',
      'fumadocs-core > extend',
      'fumadocs-mdx > extend',
      'fumadocs-core > style-to-js',
      'fumadocs-mdx > style-to-js',
      // we do not import `next/image` directly, but fumadocs does.
      "@unpic/react",
    ],
  },
  plugins: [
    tailwindcss(),
    mdx(MdxConfig),,
    vinext(),
  ],
});
