import { defineConfig, type Plugin } from "vite-plus";
import vinext from "vinext";

const REACT_EXTERNALS = new Set(["react", "react-dom", "react-dom/server"]);

function withoutReact(external: unknown): unknown {
  return Array.isArray(external)
    ? external.filter((name) => !REACT_EXTERNALS.has(name as string))
    : external;
}

// vinext always leaves React external in the SSR build. Strip it after vinext's
// config hooks run so the server bundle inlines React and the externals
// manifest omits it: the standalone output must still ship the React that
// vinext's own production server imports.
const bundleReact: Plugin = {
  name: "fixture:bundle-react",
  enforce: "post",
  config(config) {
    if (config.ssr) config.ssr.external = withoutReact(config.ssr.external) as string[];
  },
  configEnvironment(_name, config) {
    if (config.resolve) {
      config.resolve.external = withoutReact(config.resolve.external) as string[];
    }
  },
};

export default defineConfig({
  plugins: [vinext(), bundleReact],
});
