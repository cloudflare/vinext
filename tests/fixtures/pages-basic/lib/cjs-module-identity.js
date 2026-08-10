import path from "node:path";
import regeneratorRuntimePath from "next/dist/compiled/regenerator-runtime/path";
import localIdentity from "./cjs-local-identity.cjs";

export function readCjsModuleIdentity() {
  return {
    runtimePath: regeneratorRuntimePath.path,
    projectRuntimePath: path.join(__dirname, "project-runtime.js"),
    types: `${typeof __filename}:${typeof __dirname}`,
    consistent: path.dirname(__filename) === __dirname && localIdentity.consistent,
    localRuntimePath: path.join(localIdentity.dirname, "local-runtime.js"),
    localTypes: localIdentity.types,
    shadowedProcess: localIdentity.shadowedProcess,
    userMarkerTypes: localIdentity.userMarkerTypes,
  };
}
