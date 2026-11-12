import vinext from "vinext";

export default {
  plugins: [vinext({ prerender: { routes: "*" } })],
};
