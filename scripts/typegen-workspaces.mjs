import path from "node:path";
import { generateRouteTypes } from "../packages/vinext/dist/typegen.js";

const workspaceRoots = [
  "examples/pages-router-cloudflare",
  "examples/realworld-api-rest",
  "tests/fixtures/app-basic",
  "tests/fixtures/app-bfcache",
  "tests/fixtures/app-type-only-imports",
  "tests/fixtures/app-with-src",
  "tests/fixtures/pages-basepath-trailing-slash",
  "tests/fixtures/pages-basic",
  "tests/fixtures/root-layout-redirect",
];

for (const workspaceRoot of workspaceRoots) {
  await generateRouteTypes({ root: path.resolve(workspaceRoot) });
}
