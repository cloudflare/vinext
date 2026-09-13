import fs from "node:fs";

const manifest = fs.readFileSync("cacheability-manifest.json", "utf8");
fs.writeFileSync(
  "dist/server/__vinext_cacheability_manifest.js",
  `export default ${JSON.stringify(manifest)};\n`,
);
