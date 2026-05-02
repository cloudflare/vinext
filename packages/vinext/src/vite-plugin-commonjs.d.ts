declare module "vite-plugin-commonjs" {
  import type { Plugin } from "vite";

  export type CommonJsPluginOptions = {
    [key: string]: unknown;
  };

  export default function commonjs(options?: CommonJsPluginOptions): Plugin;
}
